const govukPrototypeKit = require('govuk-prototype-kit')
const router = govukPrototypeKit.requests.setupRouter()

// -----------------------------------------------------------------------------
// Task list mode (the check-data paper journey)
//
// The three tasks on /record-results-tasks hand off to screens that were
// built as standalone linear journeys: finishing one carries the vet on
// into the next screen of that journey rather than back to the list, so
// there is no way to pick up the remaining tasks.
//
// The GDS task list pattern is that each task is a self-contained section
// which returns the user to the list when it is done, and that every page
// inside a section offers a way back. Both halves are here:
//
//   1. Each task link goes through /record-results-task/<section>, which
//      records which section the vet is in. When a route inside that
//      section redirects past its own last page, the redirect is turned
//      into a return to the task list.
//   2. While in task mode, every page carries a "Return to the task list"
//      link, so a vet who changes their mind mid-section is not stranded.
//
// Scoped to the section the vet actually entered, so the same redirect
// (for example to skin-test-confirmation) still behaves normally in the
// standalone v1-0..v1-5 journeys, which must not change.
// -----------------------------------------------------------------------------
const RECORD_TASK_SECTIONS = {
  // Picking untested cattle runs on into the part-test question, which
  // belongs to this task; it ends when the journey moves on to asking
  // about cattle that are not on the list.
  untested: {
    entry: '/v1-3/skin-test-untested',
    // Once anything is recorded the task opens on what is recorded, not on
    // the empty picker. A vet who sees "25 recorded" and clicks it is
    // asking to see the 25, not to choose 25 again.
    review: '/record-results-review/untested',
    exits: ['skin-test-add-cattle-question', 'skin-test-confirmation']
  },
  // Add-another finishes by moving on to the untested animals it would
  // normally ask about next. That is task 1's job here.
  reactions: {
    entry: '/v1-5/skin-test-reactions',
    review: '/record-results-review/reactions',
    exits: ['skin-test-untested-animals', 'skin-test-add-cattle-question', 'skin-test-confirmation']
  },
  'add-cattle': {
    entry: '/v1-4/skin-test-add-cattle-question',
    // The added-cattle screen is already a review of what was added, so
    // it is the landing page rather than a review of our own. It is not
    // used as an exit target - its own Continue leads to the
    // confirmation, which would bounce straight back to it.
    review: '/v1-4/skin-test-added-cattle',
    reviewIsExternal: true,
    exits: ['skin-test-confirmation']
  },
  // The escape hatch: work down all 102 in v1-4. No exits are trapped -
  // the vet has chosen the linear journey, so it should behave like one -
  // but the return link stays available.
  all: {
    entry: '/v1-4/skin-test-reactors',
    exits: []
  }
}

// ---------------------------------------------------------------------
// Check answers: Change comes back to the check page
//
// The check answers pattern asks that changing an answer returns the user
// to the check page. These screens were built as steps in a linear
// journey, so their POSTs redirect to whatever comes next - a vet who
// clicked Change on the test date was walked through test type, batch
// numbers, reactors and untested before they saw the check page again.
//
// Rather than rewire every one of those steps (they are still journey
// steps for a vet going through in order), the Change link says where it
// came from, and the first redirect that means "this edit is finished" is
// sent there instead.
//
// A change that genuinely needs more than one screen names the pages that
// count as part of the same edit; redirects to those pass through
// untouched. Changing the test type to one that needs new batch numbers
// still asks for them - and returns to the check page when it has them.
const CHECK_CHANGE_CONTINUE = {
  'skin-test-date': [],
  'skin-test-type': ['skin-test-batch-details'],
  'skin-test-batch-details': ['skin-test-batch-details']
}

// The screen a path belongs to, ignoring the version and anything after
// it: /v1-4/skin-test-batch-details/sicct is the batch details screen.
function checkChangeKey(path) {
  const m = String(path || '').match(/\/v1-\d+\/(skin-test-[a-z0-9-]+)/)
  return m ? m[1] : null
}

router.use(function (req, res, next) {
  const data = (req.session && req.session.data) || {}
  const key = checkChangeKey(req.path)

  // Arriving with ?return= starts a change.
  if (key && req.method === 'GET' && req.query && req.query.return) {
    const to = recordSafeReturn(req.query.return)
    if (to) {
      data.checkChangeReturn = to
      data.checkChangeFrom = key
    }
  }

  let from = data.checkChangeFrom
  const back = data.checkChangeReturn

  // A GET for anything outside the current change means the vet went
  // somewhere else - including landing back on the check page. Forget it,
  // so a redirect much later in the session is not hijacked.
  if (from && req.method === 'GET' && key !== from &&
      (CHECK_CHANGE_CONTINUE[from] || []).indexOf(key) === -1) {
    data.checkChangeReturn = null
    data.checkChangeFrom = null
    from = null
  }

  if (!from || !back) return next()

  const onward = res.redirect.bind(res)
  res.redirect = function (url) {
    if (typeof url === 'string') {
      const target = checkChangeKey(url)
      const stillEditing = target === from ||
        (CHECK_CHANGE_CONTINUE[from] || []).indexOf(target) !== -1
      if (!stillEditing) {
        data.checkChangeReturn = null
        data.checkChangeFrom = null
        return onward(back)
      }
    }
    return onward(url)
  }
  next()
})

// Leaving the check-data journey altogether. Anything under /record-results
// keeps task mode; these clear it, so the standalone journeys and the home
// and start pages are never decorated with a return link.
function recordClearsTaskMode(path) {
  if (path === '/' || path === '/start') return true
  return /\/(dashboard|skin-test-submitted|report-submitted)$/.test(path)
}

router.use(function (req, res, next) {
  const data = (req.session && req.session.data) || {}

  if (recordClearsTaskMode(req.path)) {
    if (req.session && req.session.data) {
      req.session.data.recordTaskMode = null
      req.session.data.recordTaskSection = null
      req.session.data.recordTaskReturn = null
      req.session.data.recordTaskHome = null
    }
    return next()
  }

  // Show the return link on every page outside the check-data screens
  // (those carry their own back links and would end up with two).
  //
  // The Prototype Kit copies session data into res.locals.data before this
  // runs, so the flag has to be written to both to reach the layout on
  // this request rather than the next one - the same mirroring
  // v14SeedSession does.
  const showReturn = data.recordTaskMode === 'yes' && req.path.indexOf('/record-results') !== 0
  // Which list the vet came from. Paper and device show the same four
  // tasks on different pages, so someone who started at the device check
  // has to land back on the device check, not on the paper list.
  const home = data.recordTaskHome || '/record-results-tasks'
  if (req.session && req.session.data) {
    req.session.data.recordTaskReturn = showReturn ? 'yes' : null
    req.session.data.recordTaskHome = home
  }
  if (res.locals) {
    // Mutate the kit's copy rather than replacing it - replacing would drop
    // every other value the page needs.
    if (!res.locals.data) res.locals.data = {}
    res.locals.data.recordTaskReturn = showReturn ? 'yes' : null
    res.locals.data.recordTaskHome = home
  }

  if (data.recordTaskMode !== 'yes') return next()

  // The check-data screens are never inside a section, and their own
  // redirects must not be rewritten - notably the task entry route below,
  // which redirects to a page that is another section's exit.
  if (req.path.indexOf('/record-results') === 0) return next()

  const section = RECORD_TASK_SECTIONS[data.recordTaskSection]
  if (!section || !section.exits.length) return next()

  const originalRedirect = res.redirect.bind(res)
  res.redirect = function (url) {
    if (typeof url === 'string') {
      const lastSegment = url.split('?')[0].split('#')[0].split('/').pop()
      if (section.exits.indexOf(lastSegment) !== -1) {
        return originalRedirect(
          (section.review && !section.reviewIsExternal) ? section.review : home
        )
      }
    }
    return originalRedirect(url)
  }
  next()
})

// -----------------------------------------------------------------------------
// Version feature checks
//
// v1-4 is a fork of v1-3: it inherits every v1-3 behaviour and then overrides
// the reactor step with a single-pass herd review (see the v1-4 block in
// registerSkinTestRoutes). Every "is this v1-3 or later?" feature check runs
// through this helper so a new version only has to be added in one place.
// -----------------------------------------------------------------------------
// Everything from v1-3 onwards shares the v1-3 feature set: the richer
// herd datasets, the test-agnostic measurement URL, the part-test scope,
// and so on. Both V5 variants (v1-4 table, v1-5 add another) fork from
// v1-3, so both belong here - v1-5 was reading the generated V1-0 herd
// rather than Mill House until it was added.
function isV13Plus(version) {
  return version === 'v1-3' || version === 'v1-4' || version === 'v1-5'
}

// SICCT interpretation lives in its own helper so the route file
// stays focused on routing and the page templates never have to
// encode TB interpretation rules themselves. See the helper for the
// rules engine and a note explaining why this is prototype-only.
const sicctInterpretation = require('./helpers/sicctInterpretation')

// -----------------------------------------------------------------------------
// Cattle breeds for the "add cattle" breed picker. Codes mirror the
// abbreviations used elsewhere in the prototype data (HF, LIM, CH...). A
// real service would use the full CTS breed list; this is a representative
// subset of common GB breeds. Names are sentence case per the content
// style; the code is shown in brackets so the vet can match either.
// -----------------------------------------------------------------------------
const CATTLE_BREEDS = [
  ['AA', 'Aberdeen Angus'],
  ['AAX', 'Aberdeen Angus cross'],
  ['AY', 'Ayrshire'],
  ['BB', 'British Blue'],
  ['BALX', 'British Blue cross'],
  ['BF', 'British Friesian'],
  ['BSH', 'Beef Shorthorn'],
  ['CH', 'Charolais'],
  ['CHX', 'Charolais cross'],
  ['DEV', 'Devon'],
  ['DEX', 'Dexter'],
  ['FR', 'Friesian'],
  ['GAL', 'Galloway'],
  ['BGAL', 'Belted Galloway'],
  ['GUE', 'Guernsey'],
  ['HER', 'Hereford'],
  ['HERX', 'Hereford cross'],
  ['HIG', 'Highland'],
  ['HF', 'Holstein Friesian'],
  ['HOL', 'Holstein'],
  ['JE', 'Jersey'],
  ['LIM', 'Limousin'],
  ['LIMX', 'Limousin cross'],
  ['LON', 'Longhorn'],
  ['MON', 'Montbeliarde'],
  ['SAL', 'Salers'],
  ['SD', 'South Devon'],
  ['SH', 'Dairy Shorthorn'],
  ['SIM', 'Simmental'],
  ['SIMX', 'Simmental cross'],
  ['STA', 'Stabiliser'],
  ['WAG', 'Wagyu'],
  ['OTH', 'Other']
]

// Build govukSelect items for the breed picker. The select is progressively
// enhanced into an accessible autocomplete on the page; if JavaScript is
// unavailable it stays a working select. A previously-entered breed that
// isn't in the list (e.g. free text from before this became a picker) is
// preserved so editing an animal never silently drops its breed.
function buildBreedItems(selected) {
  const sel = (selected || '').trim()
  const items = [{ value: '', text: '' }]
  let found = false
  CATTLE_BREEDS.forEach(function (b) {
    if (b[0] === sel) found = true
    items.push({ value: b[0], text: b[1] + ' (' + b[0] + ')', selected: b[0] === sel })
  })
  if (sel && !found) {
    items.splice(1, 0, { value: sel, text: sel, selected: true })
  }
  return items
}

// Record a report the vet has just filed so it appears in the dashboard's
// "Recently completed" section. Keyed by CPH + type so re-completing the
// same report replaces the old entry, and kept most-recent-first.
function recordCompletedReport(req, record) {
  if (!record || !record.cph) return
  const list = Array.isArray(req.session.data.completedReports)
    ? req.session.data.completedReports.slice()
    : []
  const filtered = list.filter(function (r) {
    return !(r && r.cph === record.cph && r.type === record.type)
  })
  filtered.unshift({
    cph: record.cph,
    farm: record.farm || 'Selected farm',
    type: record.type,
    typeLabel: record.typeLabel,
    completedAt: new Date().toISOString(),
    // Snapshot of what was filed, so the vet can reopen and amend it exactly
    // as submitted (only skin test reports carry one for now).
    snapshot: record.snapshot || null
  })
  req.session.data.completedReports = filtered
}

// The session keys that together make up the CONTENT of a filed skin test
// report (measurements, reactors, untested, dates, test type, batches, who
// tested, and the selected farm). Deliberately excludes workflow state such
// as skinTestInProgress, skinTestListPrepared, skinTestPartTests and
// skinTestScopeIds. Used to snapshot a completed report so the vet can
// reopen and amend exactly what they filed.
const SKIN_TEST_REPORT_KEYS = [
  'skinTestEntries', 'skinTestAddedEntries',
  'skinTestReactors', 'skinTestReactorsByPhase',
  'skinTestUntested', 'skinTestUntestedReasons', 'skinTestUntestedReasonOthers',
  'skinTestType', 'skinTestFirstOrder', 'skinTestTests', 'skinTestCompletedTests',
  'currentSkinTest', 'currentSkinTestPhase',
  'skinTestDay1Day', 'skinTestDay1Month', 'skinTestDay1Year',
  'skinTestDay1StartTimeHour', 'skinTestDay1StartTimeMinute', 'skinTestDay1StartTimeAmpm',
  'skinTestDay1OverMultipleDays', 'skinTestMultiDay',
  'skinTestDay2Day', 'skinTestDay2Month', 'skinTestDay2Year',
  'skinTestDay2StartTimeHour', 'skinTestDay2StartTimeMinute', 'skinTestDay2StartTimeAmpm',
  'skinTestDay2Calculated', 'skinTestDay2OverMultipleDays',
  'skinTestSicctBatches', 'skinTestDivaBatches', 'skinTestBatchDetails',
  'skinTestSortBy', 'skinTestSortDirection',
  'administeredBy', 'theirRole',
  'selectedCattle', 'selectedCattleLabel'
]

// Copy the report-content keys out of session into a plain object (deep
// cloned so later edits don't mutate the stored snapshot).
function snapshotSkinTestReport(req) {
  const data = req.session.data || {}
  const snap = {}
  SKIN_TEST_REPORT_KEYS.forEach(function (k) {
    if (data[k] !== undefined) snap[k] = data[k]
  })
  try { return JSON.parse(JSON.stringify(snap)) } catch (e) { return snap }
}

// Restore a snapshot back into session so the check-answers page shows the
// report exactly as it was filed. Every report-content key is set from the
// snapshot (or cleared if the snapshot didn't have it), so no stale values
// from other work leak in. Workflow scope is cleared; the report is marked
// in progress so the Change pages behave as a live edit.
function restoreSkinTestReport(req, snapshot) {
  if (!snapshot) return
  SKIN_TEST_REPORT_KEYS.forEach(function (k) {
    if (snapshot[k] !== undefined) req.session.data[k] = snapshot[k]
    else delete req.session.data[k]
  })
  req.session.data.skinTestScopeIds = null
  req.session.data.skinTestInProgress = true
}

// The session keys that make up the CONTENT of a filed BCG vaccination
// report: the per-animal decisions and reason overrides, the derived
// vaccinated / not-vaccinated snapshots the check-answers page reads, any
// manually added cattle, the batch / diluent / date details, and the
// selected farm. Used to snapshot a completed vaccination report so the vet
// can reopen and amend exactly what they filed – the same pattern as the
// skin-test snapshot above.
const VACCINATION_REPORT_KEYS = [
  'cattleDecisions', 'otherReasons',
  'vaccinatedCattle', 'remainingCattleUpdates',
  'vaccinationAddedAnimals',
  'vaccinationApproach', 'markingPhase', 'activeReviewGroup',
  'vaccinationDateDay', 'vaccinationDateMonth', 'vaccinationDateYear',
  'batchNumber', 'batchExpiryDateDay', 'batchExpiryDateMonth', 'batchExpiryDateYear',
  'diluentBatchNumber', 'diluentBatchExpiryDateDay', 'diluentBatchExpiryDateMonth', 'diluentBatchExpiryDateYear',
  'vaccinationNote',
  'selectedCattle', 'selectedCattleLabel'
]

function snapshotVaccinationReport(req) {
  const data = req.session.data || {}
  const snap = {}
  VACCINATION_REPORT_KEYS.forEach(function (k) {
    if (data[k] !== undefined) snap[k] = data[k]
  })
  try { return JSON.parse(JSON.stringify(snap)) } catch (e) { return snap }
}

function restoreVaccinationReport(req, snapshot) {
  if (!snapshot) return
  VACCINATION_REPORT_KEYS.forEach(function (k) {
    if (snapshot[k] !== undefined) req.session.data[k] = snapshot[k]
    else delete req.session.data[k]
  })
}

// Build the "Richmond - DL10 4NP - 38 cattle" line for a herd record. The
// address is stored as "<name>, <town>, <postcode>", so town and postcode
// are the last two comma-separated parts. Used on the dashboard and the
// per-farm tasks page so the farm reads the same everywhere.
function farmLocationLine(herd) {
  if (!herd) return null
  const parts = String(herd.address || '')
    .split(',').map(function (s) { return s.trim() }).filter(Boolean)
  const postcode = parts.length ? parts[parts.length - 1] : ''
  const town = parts.length >= 2 ? parts[parts.length - 2] : ''
  const cattle = herd.cattle ? herd.cattle + ' cattle' : ''
  return [town, postcode, cattle].filter(Boolean).join(' - ') || null
}

// -----------------------------------------------------------------------------
// Herd data: 20 representative English cattle farms
// -----------------------------------------------------------------------------
const herdData = {
  '12/345/6789': { cph: '12/345/6789', farm: 'Hill Farm', address: 'Hill Farm, York, YO1 1AA', cattle: '244' },
  '17/205/6790': { cph: '17/205/6790', farm: 'Moor Farm', address: 'Moor Farm, Leeds, LS1 2AB', cattle: '58' },
  // Orchard Gate Farm – main holding + dairy unit
  '12/340/6791':    { cph: '12/340/6791',    farm: 'Orchard Gate Farm', address: 'Orchard Gate Farm, Ripon, HG4 1BC',            cattle: '80',  holdingLabel: 'Main holding' },
  '12/340/6791-01': { cph: '12/340/6791-01', farm: 'Orchard Gate Farm', address: 'Orchard Gate Dairy Unit, Ripon, HG4 1BC',      cattle: '52',  holdingLabel: 'Dairy unit' },
  '12/348/6792': { cph: '12/348/6792', farm: 'Willow Bank Farm', address: 'Willow Bank Farm, Selby, YO8 4CD', cattle: '41' },
  '12/325/6793': { cph: '12/325/6793', farm: 'Red Barn Farm', address: 'Red Barn Farm, Thirsk, YO7 3DE', cattle: '173' },
  '12/338/6794': { cph: '12/338/6794', farm: 'Meadow View Farm', address: 'Meadow View Farm, Harrogate, HG1 5EF', cattle: '97' },
  '12/360/6795': { cph: '12/360/6795', farm: 'Low Beck Farm', address: 'Low Beck Farm, Malton, YO17 7FG', cattle: '326' },
  '12/315/6796': { cph: '12/315/6796', farm: 'West Field Farm', address: 'West Field Farm, Bedale, DL8 1GH', cattle: '119' },
  '12/310/6797': { cph: '12/310/6797', farm: 'Oak Tree Farm', address: 'Oak Tree Farm, Skipton, BD23 2HJ', cattle: '64' },
  '24/420/6798': { cph: '24/420/6798', farm: 'Stonebridge Farm', address: 'Stonebridge Farm, Beverley, HU17 8JK', cattle: '212' },
  // High Pastures Farm – main holding + beef finishing unit
  '12/320/6799':    { cph: '12/320/6799',    farm: 'High Pastures Farm', address: 'High Pastures Farm, Northallerton, DL7 9KL',   cattle: '200', holdingLabel: 'Main holding' },
  '12/320/6799-01': { cph: '12/320/6799-01', farm: 'High Pastures Farm', address: 'High Pastures Beef Unit, Northallerton, DL7 9KL', cattle: '187', holdingLabel: 'Beef finishing unit' },
  '24/402/6800': { cph: '24/402/6800', farm: 'Green Lane Farm', address: 'Green Lane Farm, Pocklington, YO42 1LM', cattle: '72' },
  '24/405/6801': { cph: '24/405/6801', farm: 'Sunnyside Farm', address: 'Sunnyside Farm, Driffield, YO25 6MN', cattle: '158' },
  // 102, not 38. Mill House is the research herd every v1-3+ screen is
  // built on and it holds 102 cattle; the search results and the herd
  // summary were still quoting a number from before that herd existed, so
  // a vet was told 38 and then handed a list of 102.
  '12/312/6802': { cph: '12/312/6802', farm: 'Mill House Farm', address: 'Mill House Farm, Richmond, DL10 4NP', cattle: '102' },
  '12/365/6803': { cph: '12/365/6803', farm: 'Hazelcroft Farm', address: 'Hazelcroft Farm, Helmsley, YO62 5PQ', cattle: '146' },
  // Birch Hollow Farm – main holding + youngstock unit
  '17/221/6804':    { cph: '17/221/6804',    farm: 'Birch Hollow Farm', address: 'Birch Hollow Farm, Otley, LS21 3QR',           cattle: '250', holdingLabel: 'Main holding' },
  '17/221/6804-01': { cph: '17/221/6804-01', farm: 'Birch Hollow Farm', address: 'Birch Hollow Youngstock Unit, Otley, LS21 3QR', cattle: '171', holdingLabel: 'Youngstock unit' },
  '17/218/6805': { cph: '17/218/6805', farm: 'Rosewood Farm', address: 'Rosewood Farm, Wetherby, LS22 6RS', cattle: '89' },
  '12/355/6806': { cph: '12/355/6806', farm: 'Brookside Farm', address: 'Brookside Farm, Easingwold, YO61 3ST', cattle: '184' },
  '12/370/6807': { cph: '12/370/6807', farm: 'Elm Carr Farm', address: 'Elm Carr Farm, Pickering, YO18 7TU', cattle: '267' },
  // Riverside Farm – main holding + dairy unit + beef finishing unit
  '12/352/6808':    { cph: '12/352/6808',    farm: 'Riverside Farm', address: 'Riverside Farm, Tadcaster, LS24 9UV',            cattle: '300', holdingLabel: 'Main holding' },
  '12/352/6808-01': { cph: '12/352/6808-01', farm: 'Riverside Farm', address: 'Riverside Dairy Unit, Tadcaster, LS24 9UV',      cattle: '130', holdingLabel: 'Dairy unit' },
  '12/352/6808-02': { cph: '12/352/6808-02', farm: 'Riverside Farm', address: 'Riverside Beef Finishing Unit, Tadcaster, LS24 9UV', cattle: '82',  holdingLabel: 'Beef finishing unit' }
}
 
function searchResultsForTerm(search) {
  const term = (search || '').toLowerCase()

  return Object.entries(herdData)
    .map(([value, herd]) => ({
      value,
      text: `${herd.cph}, ${herd.farm}`,
      html: `<strong>${herd.cph}, ${herd.farm}</strong>`,
      hint: {
        text: `${herd.address.replace(herd.farm + ', ', '')} – ${herd.cattle} cattle`
      }
    }))
    .filter(item =>
      item.text.toLowerCase().includes(term) ||
      item.value.toLowerCase().includes(term) ||
      item.hint.text.toLowerCase().includes(term)
    )
}

// -----------------------------------------------------------------------------
// V1-1 multi-field farm search
//
// A single search input accepts any combination of CPH, farm name, postcode
// and ear tag. The query is split into whitespace tokens; each token is then
// checked against every CPH's searchable blob (cph + farm + address +
// holding label). Tokens that look like ear tags also trigger a scan of the
// animal dataset so a farm can be found by its cattle.
//
// Each CPH gets a score that rewards:
//   * each token that matches anywhere in the blob
//   * exact CPH or farm-name matches
//   * ear-tag hits (strong boost so an ear tag always wins over a loose
//     text match)
//
// After ranking, the CPHs are grouped by farm name so the results page can
// show a farm and all its sub-holdings in a single block.
// -----------------------------------------------------------------------------

function extractTown(address) {
  const parts = String(address || '').split(',').map(s => s.trim())
  return parts[parts.length - 2] || parts[0] || ''
}

function extractPostcode(address) {
  const parts = String(address || '').split(',').map(s => s.trim())
  return parts[parts.length - 1] || ''
}

function earTagCphMatches(tokens) {
  const hits = new Set()
  if (!tokens.length) return hits

  // Only treat a token as an ear-tag query when it's clearly ear-tag-shaped:
  //   - starts with "UK" (any number of trailing digits, 4+), OR
  //   - is 5+ digits long (4-digit numbers are ambiguous with CPH fragments).
  // Matching uses equality or trailing-digits only; we deliberately don't
  // match substrings in the middle of an ear tag – that would create lots
  // of false positives from short digit fragments.
  const digitTokens = []
  for (const t of tokens) {
    const startsWithUk = /^uk/i.test(t)
    const cleaned = t.replace(/^uk/i, '').replace(/[^0-9]/g, '')
    if (cleaned.length >= (startsWithUk ? 4 : 5)) {
      digitTokens.push(cleaned)
    }
  }
  if (!digitTokens.length) return hits

  for (const cph of Object.keys(v11AnimalsByCph)) {
    const animals = v11AnimalsByCph[cph] || []
    for (let i = 0; i < animals.length; i++) {
      const id = animals[i].officialId
      let matched = false
      for (const dt of digitTokens) {
        if (id === 'UK' + dt || id.endsWith(dt)) {
          matched = true
          break
        }
      }
      if (matched) {
        hits.add(cph)
        break
      }
    }
  }
  return hits
}

function searchV11(query) {
  const q = String(query || '').trim()
  if (!q) {
    return { candidates: [], groups: [] }
  }

  const tokens = q.split(/\s+/).map(t => t.toLowerCase()).filter(Boolean)
  const earTagHits = earTagCphMatches(tokens)

  const candidates = []
  for (const cph of Object.keys(herdData)) {
    const herd = herdData[cph]
    const blob = [
      cph,
      herd.farm || '',
      herd.address || '',
      herd.holdingLabel || ''
    ].join(' ').toLowerCase()

    let tokenMatches = 0
    for (const token of tokens) {
      if (blob.includes(token)) tokenMatches++
    }

    let score = tokenMatches * 2
    if (earTagHits.has(cph)) score += 20
    if (tokens.some(t => t === cph.toLowerCase())) score += 5
    const farmLower = (herd.farm || '').toLowerCase()
    if (tokens.some(t => farmLower === t)) score += 5

    if (score > 0) {
      candidates.push({ cph, herd, score, tokenMatches, earTagMatch: earTagHits.has(cph) })
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return (a.herd.farm || '').localeCompare(b.herd.farm || '')
  })

  const groups = groupResultsByFarm(candidates)

  return { candidates, groups }
}

function groupResultsByFarm(candidates) {
  // Collect every farm that had at least one matching CPH.
  const matchedFarms = new Set(candidates.map(c => c.herd.farm))
  const scoreByFarm = {}
  candidates.forEach(c => {
    const name = c.herd.farm
    if ((scoreByFarm[name] || 0) < c.score) scoreByFarm[name] = c.score
  })

  // For each matched farm, include ALL of that farm's CPHs so users can
  // pick between the main holding and any sub-holdings even when they only
  // typed part of the query.
  const groupsByFarm = {}
  for (const cph of Object.keys(herdData)) {
    const herd = herdData[cph]
    if (!matchedFarms.has(herd.farm)) continue

    if (!groupsByFarm[herd.farm]) {
      groupsByFarm[herd.farm] = {
        farm: herd.farm,
        location: extractTown(herd.address),
        postcode: extractPostcode(herd.address),
        totalCattle: 0,
        topScore: scoreByFarm[herd.farm] || 0,
        cphs: []
      }
    }
    groupsByFarm[herd.farm].cphs.push({
      cph,
      holdingLabel: herd.holdingLabel || 'Main holding',
      cattle: herd.cattle,
      address: herd.address
    })
    groupsByFarm[herd.farm].totalCattle += Number(herd.cattle) || 0
  }

  // Sort CPHs inside each group: main holding first, then sub-holdings.
  Object.values(groupsByFarm).forEach(g => {
    g.cphs.sort((a, b) => {
      const aMain = a.cph.indexOf('-') === -1
      const bMain = b.cph.indexOf('-') === -1
      if (aMain !== bMain) return aMain ? -1 : 1
      return a.cph.localeCompare(b.cph)
    })
  })

  return Object.values(groupsByFarm).sort((a, b) => {
    if (b.topScore !== a.topScore) return b.topScore - a.topScore
    return a.farm.localeCompare(b.farm)
  })
}

function renderSearchPage(req, res, pageName, errors) {
  return res.render(pageName, {
    errors,
    errorSummary: errors
      ? {
          titleText: 'There is a problem',
          errorList: Object.keys(errors).map((key) => ({
            text: errors[key].text,
            href: `#${key}`
          }))
        }
      : null
  })
}

function handleFarmSearch(req, res, pageName, version) {
  const searchInput = (req.body.cattleSearch || req.body.search || '').trim()

  req.session.data.cattleSearch = searchInput
  req.session.data.search = searchInput

  if (!searchInput) {
    const message = pageName === 'v1-3/search'
      ? 'Enter a search term'
      : 'Enter a CPH, farm name, postcode or ear tag'
    return renderSearchPage(req, res, pageName, {
      cattleSearch: { text: message }
    })
  }

  if (version === 'v1-1' || (version === 'v1-2' || isV13Plus(version))) {
    const { candidates, groups } = searchV11(searchInput)
    req.session.data.searchResultGroups = groups
    // Keep a flat list for any legacy page that still reads searchResults.
    req.session.data.searchResults = candidates.map(c => ({
      value: c.cph,
      text: `${c.herd.cph}, ${c.herd.farm}`,
      html: `<strong>${c.herd.cph}, ${c.herd.farm}</strong>`,
      hint: {
        text: `${c.herd.address.replace(c.herd.farm + ', ', '')} – ${c.herd.cattle} cattle`
      }
    }))
  } else {
    req.session.data.searchResults = searchResultsForTerm(searchInput)
  }

  res.redirect(`/${version}/search-results`)
}

function handleReportSearch(req, res, pageName, version) {
  const searchInput = (req.body.reportSearch || '').trim()

  req.session.data.reportSearch = searchInput

  if (!searchInput) {
    return renderSearchPage(req, res, pageName, {
      reportSearch: { text: 'Enter a CPH, farm name or ear tag' }
    })
  }

  req.session.data.reportSearchResults = searchResultsForTerm(searchInput)
  res.redirect(`/${version}/choose-a-herd-or-animal-to-report`)
}

// -----------------------------------------------------------------------------
// Download list preview data and helpers
// -----------------------------------------------------------------------------
const baseAnimalData = {
  '12/345/6789': [
    {
      officialId: 'UK341234412177',
      earTagNumber: 'UK341234412177',
      barcode: 'UK341234412177',
      breed: 'HF',
      dob: '06/12/2022',
      age: 28,
      sex: 'F',
      vaccinationStatus: 'Vaccinated',
      notes: 'Duplicate'
    },
    {
      officialId: 'UK341123302177',
      earTagNumber: 'UK341123302177',
      barcode: 'UK341123302177',
      breed: 'BF',
      dob: '06/12/2024',
      age: 4,
      sex: 'F',
      vaccinationStatus: 'Not vaccinated',
      notes: 'NO Gamma'
    },
    {
      officialId: 'UK341567812199',
      earTagNumber: 'UK341567812199',
      barcode: 'UK341567812199',
      breed: 'AAX',
      dob: '13/03/2023',
      age: 25,
      sex: 'M',
      vaccinationStatus: 'Vaccinated',
      notes: ''
    }
  ],
  '17/205/6790': [
    {
      officialId: 'UK120900112301',
      earTagNumber: 'UK120900112301',
      barcode: 'UK120900112301',
      breed: 'LIM',
      dob: '02/02/2023',
      age: 26,
      sex: 'F',
      vaccinationStatus: 'Vaccinated',
      notes: ''
    },
    {
      officialId: 'UK120900112302',
      earTagNumber: 'UK120900112302',
      barcode: 'UK120900112302',
      breed: 'CH',
      dob: '19/08/2024',
      age: 8,
      sex: 'M',
      vaccinationStatus: 'Not vaccinated',
      notes: ''
    }
  ]
}

const herdTagConfig = {
  '12/345/6789': { herdMark: '341234', checkDigit: '4' },
  '17/205/6790': { herdMark: '120900', checkDigit: '1' },
  '12/348/6792': { herdMark: '123456', checkDigit: '7' },
  '12/352/6808': { herdMark: '183483', checkDigit: '7' }
}

const availableListColumns = ['Age', 'DOB', 'Sex', 'Breed', 'Vaccination status']

function formatDateForOffset(monthOffset, day) {
  const date = new Date(Date.UTC(2026, 3, 14))
  date.setUTCMonth(date.getUTCMonth() - monthOffset)
  date.setUTCDate(day)

  const dd = String(date.getUTCDate()).padStart(2, '0')
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = date.getUTCFullYear()
  return `${dd}/${mm}/${yyyy}`
}

function createGeneratedAnimal(cph, index) {
  const fallbackDigits = String(cph || '').replace(/\D/g, '')
  const config = herdTagConfig[cph] || {
    herdMark: (fallbackDigits.slice(0, 6) || '123456').padEnd(6, '0'),
    checkDigit: fallbackDigits.slice(6, 7) || '1'
  }
  const breeds = ['HF', 'BF', 'AAX', 'LIM', 'CH']
  const sex = index % 5 === 0 ? 'M' : 'F'
  const age = 4 + (index % 32)
  const vaccinationStatus = index % 4 === 0 ? 'Not vaccinated' : 'Vaccinated'
  const individual = String(index + 1).padStart(5, '0')
  const officialId = `UK${config.herdMark}${config.checkDigit}${individual}`

  return {
    officialId,
    earTagNumber: officialId,
    barcode: officialId,
    breed: breeds[index % breeds.length],
    dob: formatDateForOffset(age, (index % 28) + 1),
    age,
    sex,
    vaccinationStatus,
    notes: ''
  }
}

// -----------------------------------------------------------------------------
// V1-1 realistic herd dataset
//
// For each farm we build a more representative list of animals:
//   * 70–80% of cattle share the farm's own herd mark (home-born), with
//     near-sequential individual numbers that contain small random gaps to
//     simulate real births over time.
//   * 10–18% carry a different herd mark (moved in from another farm).
//   * 5–9% share the last 4 digits of another animal on the same farm but
//     use a different herd mark – the realistic "ear-tag duplicate" risk.
//   * 1–2 "out of place" animals with unusual numbering (older imports).
//
// Bought-in and duplicate-ending animals are shuffled through the list
// rather than grouped at the end. Data is generated once at module load
// from a deterministic PRNG (seeded from the CPH) so every request for the
// same farm returns the same list.
// V1-0 is unaffected and continues to use `createGeneratedAnimal` above.
// -----------------------------------------------------------------------------

const v11HerdMarks = {
  '12/345/6789': { mark: '341234', check: '4' },
  '17/205/6790': { mark: '120900', check: '1' },
  '12/340/6791': { mark: '562301', check: '5' },
  '12/348/6792': { mark: '123456', check: '7' },
  '12/325/6793': { mark: '473829', check: '2' },
  '12/338/6794': { mark: '258147', check: '8' },
  '12/360/6795': { mark: '369258', check: '3' },
  '12/315/6796': { mark: '741852', check: '6' },
  '12/310/6797': { mark: '852963', check: '9' },
  '24/420/6798': { mark: '963741', check: '1' },
  '12/320/6799': { mark: '147258', check: '4' },
  '24/402/6800': { mark: '321654', check: '7' },
  '24/405/6801': { mark: '654321', check: '2' },
  '12/312/6802': { mark: '987654', check: '5' },
  '12/365/6803': { mark: '456789', check: '8' },
  '17/221/6804': { mark: '246810', check: '0' },
  '17/218/6805': { mark: '135791', check: '3' },
  '12/355/6806': { mark: '579135', check: '6' },
  '12/370/6807': { mark: '813579', check: '9' },
  '12/352/6808': { mark: '183483', check: '7' }
}

const v11Breeds = ['HF', 'BF', 'AAX', 'LIM', 'CH', 'SIM', 'HER', 'BB', 'BALX', 'DS']

// Only the farms that have actually received the BCG vaccination round.
// Every other farm's animals are all "Not vaccinated".
const v11VaccinatedFarms = new Set([
  '12/345/6789', // Hill Farm
  '17/205/6790', // Moor Farm
  '12/340/6791', // Orchard Gate Farm
  '12/348/6792', // Willow Bank Farm
  '12/325/6793', // Red Barn Farm
  '12/338/6794'  // Meadow View Farm
])

// V1-1 farm TB status. Each farm has a realistic back-story a vet can read
// before choosing what to do on the visit. OTFW farms always have a recent
// breakdown date; OTF farms may have a historical breakdown or none on
// record. Last-test dates are spread from "tested last week" back to "four
// years ago" so the data feels lived-in.
const v11FarmTbStatus = {
  '12/345/6789': { status: 'OTF',  lastTestDate: '12 March 2025',     lastBreakdown: 'None recorded' },
  '17/205/6790': { status: 'OTFW', lastTestDate: '4 February 2025',   lastBreakdown: '18 August 2025' },
  '12/340/6791': { status: 'OTF',  lastTestDate: '9 January 2025',    lastBreakdown: '23 July 2023' },
  '12/348/6792': { status: 'OTF',  lastTestDate: '27 November 2025',  lastBreakdown: 'None recorded' },
  '12/325/6793': { status: 'OTFW', lastTestDate: '15 April 2025',     lastBreakdown: '2 April 2025' },
  '12/338/6794': { status: 'OTF',  lastTestDate: '5 October 2025',    lastBreakdown: 'None recorded' },
  '12/360/6795': { status: 'OTF',  lastTestDate: '30 August 2025',    lastBreakdown: '14 May 2022' },
  '12/315/6796': { status: 'OTFW', lastTestDate: '3 March 2025',      lastBreakdown: '9 February 2025' },
  '12/310/6797': { status: 'OTF',  lastTestDate: '14 June 2025',      lastBreakdown: 'None recorded' },
  '24/420/6798': { status: 'OTF',  lastTestDate: '22 December 2025',  lastBreakdown: 'None recorded' },
  '12/320/6799': { status: 'OTF',  lastTestDate: '11 March 2025',     lastBreakdown: '6 November 2024' },
  '24/402/6800': { status: 'OTF',  lastTestDate: '7 November 2025',   lastBreakdown: 'None recorded' },
  '24/405/6801': { status: 'OTFW', lastTestDate: '25 January 2025',   lastBreakdown: '12 January 2025' },
  '12/312/6802': { status: 'OTF',  lastTestDate: '26 May 2024', lastBreakdown: 'None recorded' },
  '12/365/6803': { status: 'OTF',  lastTestDate: '2 July 2025',       lastBreakdown: '16 May 2023' },
  '17/221/6804': { status: 'OTF',  lastTestDate: '28 November 2025',  lastBreakdown: 'None recorded' },
  '17/218/6805': { status: 'OTFW', lastTestDate: '8 April 2025',      lastBreakdown: '1 April 2025' },
  '12/355/6806': { status: 'OTF',  lastTestDate: '16 August 2025',    lastBreakdown: 'None recorded' },
  '12/370/6807': { status: 'OTF',  lastTestDate: '3 May 2025',        lastBreakdown: '21 February 2022' },
  '12/352/6808': { status: 'OTF',  lastTestDate: '30 January 2025',   lastBreakdown: 'None recorded' }
}

function getV11TbStatusForCph(cph) {
  // Sub-holdings share the main holding's TB status – the operation is
  // treated as a single farm for disease control purposes.
  const baseCph = String(cph || '').split('-')[0]
  const entry = v11FarmTbStatus[cph] || v11FarmTbStatus[baseCph]
  if (!entry) return null
  const fullName = entry.status === 'OTF'
    ? 'Officially TB Free'
    : 'Officially TB Free Withdrawn'
  return {
    status: entry.status,
    statusFullName: fullName,
    lastTestDate: entry.lastTestDate,
    lastBreakdown: entry.lastBreakdown
  }
}

// V1-2 farm briefing data – the data shown on the confirm-herd page so
// the vet has a snapshot of the operation (herd composition + farm
// contact from CTS) and its disease-control state (TB testing cadence,
// risk area, vaccination programme) before they pick a journey. Each
// main holding has its own combination so no two farms look alike.
// Sub-holdings inherit from the main holding because contact, risk
// area and vaccination programme are operation-wide, not CPH-specific.
const v12FarmDetails = {
  // Hill Farm – 244 cattle, beef, high risk area
  '12/345/6789': {
    bulls: 8, type: 'Beef', contact: 'Margaret Hill', phone: '07811 234 567',
    lastTbTestDay2: '15 March 2025', lastTbTestType: 'Whole herd test',
    riskArea: 'High', testInterval: 'Annual',
    nextSkinTest: 'March 2026', nextSkinTestOverdue: true,
    vaccinationStatus: 'Not vaccinated', vaccinationBooster: 'Not due'
  },
  // Moor Farm – 58 cattle, dairy, OTFW (short-interval testing)
  '17/205/6790': {
    bulls: 2, type: 'Dairy', contact: 'Peter Moorhouse', phone: '07798 654 321',
    lastTbTestDay2: '7 February 2025', lastTbTestType: 'Short interval test',
    riskArea: 'High', testInterval: '6 months',
    nextSkinTest: 'August 2025', nextSkinTestOverdue: true,
    vaccinationStatus: 'Vaccinated', vaccinationBooster: 'Due August 2026'
  },
  // Orchard Gate Farm – 80 + 52 cattle, dairy operation
  '12/340/6791': {
    bulls: 4, type: 'Dairy', contact: 'Anna Whitfield', phone: '07412 778 902',
    lastTbTestDay2: '12 January 2025', lastTbTestType: 'Whole herd test',
    riskArea: 'Edge', testInterval: 'Annual',
    nextSkinTest: 'January 2026', nextSkinTestOverdue: true,
    vaccinationStatus: 'Mixed', vaccinationBooster: 'Due June 2026'
  },
  // Willow Bank Farm – 41 cattle, dairy (matches the user-supplied
  // example so the page mirrors the spec verbatim for this farm)
  '12/348/6792': {
    bulls: 11, type: 'Dairy', contact: 'Jim Farrow', phone: '07712 345 678',
    lastTbTestDay2: '24 October 2025', lastTbTestType: 'Check test',
    lastWholeHerdTestDay2: '30 May 2025',
    riskArea: 'Edge', testInterval: '6 months',
    nextSkinTest: 'February 2026', nextSkinTestOverdue: true,
    vaccinationStatus: 'Mixed', vaccinationBooster: 'Due July 2026'
  },
  // Red Barn Farm – 173 cattle, mixed, OTFW
  '12/325/6793': {
    bulls: 6, type: 'Mixed', contact: 'David Hardcastle', phone: '07832 119 446',
    lastTbTestDay2: '18 April 2025', lastTbTestType: 'Short interval test',
    riskArea: 'High', testInterval: '6 months',
    nextSkinTest: 'October 2025', nextSkinTestOverdue: true,
    vaccinationStatus: 'Not vaccinated', vaccinationBooster: 'Not due'
  },
  // Meadow View Farm – 97 cattle, dairy, edge
  '12/338/6794': {
    bulls: 3, type: 'Dairy', contact: 'Caroline Pearson', phone: '07759 281 003',
    lastTbTestDay2: '8 October 2025', lastTbTestType: 'Pre-movement test',
    lastWholeHerdTestDay2: '12 April 2025',
    riskArea: 'Edge', testInterval: 'Annual',
    nextSkinTest: 'October 2026', nextSkinTestOverdue: false,
    vaccinationStatus: 'Vaccinated', vaccinationBooster: 'Due November 2026'
  },
  // Low Beck Farm – 326 cattle, beef, low risk
  '12/360/6795': {
    bulls: 12, type: 'Beef', contact: 'Robert Ainsworth', phone: '07901 540 778',
    lastTbTestDay2: '2 September 2025', lastTbTestType: 'Whole herd test',
    riskArea: 'Low', testInterval: '4 yearly',
    nextSkinTest: 'September 2029', nextSkinTestOverdue: false,
    vaccinationStatus: 'Not vaccinated', vaccinationBooster: 'Not due'
  },
  // West Field Farm – 119 cattle, mixed, OTFW
  '12/315/6796': {
    bulls: 5, type: 'Mixed', contact: 'Sarah Whittaker', phone: '07845 220 169',
    lastTbTestDay2: '6 March 2025', lastTbTestType: 'Short interval test',
    riskArea: 'High', testInterval: '6 months',
    nextSkinTest: 'September 2025', nextSkinTestOverdue: true,
    vaccinationStatus: 'Mixed', vaccinationBooster: 'Due May 2026'
  },
  // Oak Tree Farm – 64 cattle, dairy, edge
  '12/310/6797': {
    bulls: 2, type: 'Dairy', contact: 'Michael Sutton', phone: '07722 668 411',
    lastTbTestDay2: '17 June 2025', lastTbTestType: 'Check test',
    lastWholeHerdTestDay2: '8 February 2025',
    riskArea: 'Edge', testInterval: 'Annual',
    nextSkinTest: 'June 2026', nextSkinTestOverdue: false,
    vaccinationStatus: 'Vaccinated', vaccinationBooster: 'Due July 2026'
  },
  // Stonebridge Farm – 211 cattle, beef, high risk
  '24/420/6798': {
    bulls: 8, type: 'Beef', contact: 'Helen Stoneham', phone: '07965 442 880',
    lastTbTestDay2: '25 December 2025', lastTbTestType: 'Whole herd test',
    riskArea: 'High', testInterval: 'Annual',
    nextSkinTest: 'December 2026', nextSkinTestOverdue: false,
    vaccinationStatus: 'Not vaccinated', vaccinationBooster: 'Not due'
  },
  // High Pastures Farm – 200 + 187 cattle, beef
  '12/320/6799': {
    bulls: 9, type: 'Beef', contact: 'Christopher Vale', phone: '07432 991 220',
    lastTbTestDay2: '14 March 2025', lastTbTestType: 'Whole herd test',
    riskArea: 'High', testInterval: 'Annual',
    nextSkinTest: 'March 2026', nextSkinTestOverdue: true,
    vaccinationStatus: 'Mixed', vaccinationBooster: 'Due September 2026'
  },
  // Green Lane Farm – 72 cattle, mixed, edge
  '24/402/6800': {
    bulls: 3, type: 'Mixed', contact: 'Thomas Greenley', phone: '07559 700 314',
    lastTbTestDay2: '10 November 2025', lastTbTestType: 'Pre-movement test',
    lastWholeHerdTestDay2: '6 May 2025',
    riskArea: 'Edge', testInterval: 'Annual',
    nextSkinTest: 'November 2026', nextSkinTestOverdue: false,
    vaccinationStatus: 'Vaccinated', vaccinationBooster: 'Due December 2026'
  },
  // Sunnyside Farm – 158 cattle, dairy, OTFW
  '24/405/6801': {
    bulls: 5, type: 'Dairy', contact: 'Eleanor Sutcliffe', phone: '07881 305 778',
    lastTbTestDay2: '28 January 2025', lastTbTestType: 'Short interval test',
    riskArea: 'High', testInterval: '6 months',
    nextSkinTest: 'July 2025', nextSkinTestOverdue: true,
    vaccinationStatus: 'Mixed', vaccinationBooster: 'Due April 2026'
  },
  // Mill House Farm – 38 cattle, dairy, edge
  '12/312/6802': {
    bulls: 1, type: 'Dairy', contact: 'James Millburn', phone: '07700 412 559',
    lastTbTestDay2: '26 May 2024', lastTbTestType: 'Whole herd test',
    riskArea: 'Edge', testInterval: '2 yearly',
    nextSkinTest: 'May 2026', nextSkinTestOverdue: true,
    vaccinationStatus: 'Vaccinated', vaccinationBooster: 'Due October 2026'
  },
  // Hazelcroft Farm – 146 cattle, mixed, high risk
  '12/365/6803': {
    bulls: 5, type: 'Mixed', contact: 'Rebecca Holroyd', phone: '07999 116 045',
    lastTbTestDay2: '5 July 2025', lastTbTestType: 'Whole herd test',
    riskArea: 'High', testInterval: 'Annual',
    nextSkinTest: 'July 2026', nextSkinTestOverdue: false,
    vaccinationStatus: 'Not vaccinated', vaccinationBooster: 'Not due'
  },
  // Birch Hollow Farm – 250 + 171 cattle, beef
  '17/221/6804': {
    bulls: 10, type: 'Beef', contact: 'Alan Birchwood', phone: '07338 825 991',
    lastTbTestDay2: '1 December 2025', lastTbTestType: 'Pre-movement test',
    lastWholeHerdTestDay2: '22 May 2025',
    riskArea: 'High', testInterval: 'Annual',
    nextSkinTest: 'July 2026', nextSkinTestOverdue: false,
    vaccinationStatus: 'Mixed', vaccinationBooster: 'Due February 2027'
  },
  // Rosewood Farm – 89 cattle, mixed, OTFW
  '17/218/6805': {
    bulls: 3, type: 'Mixed', contact: 'Lucy Roseman', phone: '07644 503 280',
    lastTbTestDay2: '11 April 2025', lastTbTestType: 'Short interval test',
    riskArea: 'High', testInterval: '6 months',
    nextSkinTest: 'October 2025', nextSkinTestOverdue: true,
    vaccinationStatus: 'Vaccinated', vaccinationBooster: 'Due May 2026'
  },
  // Brookside Farm – 184 cattle, dairy, edge
  '12/355/6806': {
    bulls: 6, type: 'Dairy', contact: 'Daniel Brook', phone: '07412 668 119',
    lastTbTestDay2: '19 August 2025', lastTbTestType: 'Check test',
    lastWholeHerdTestDay2: '14 March 2025',
    riskArea: 'Edge', testInterval: 'Annual',
    nextSkinTest: 'August 2026', nextSkinTestOverdue: false,
    vaccinationStatus: 'Mixed', vaccinationBooster: 'Due September 2026'
  },
  // Elm Carr Farm – 267 cattle, beef, high
  '12/370/6807': {
    bulls: 11, type: 'Beef', contact: 'George Elmer', phone: '07852 904 117',
    lastTbTestDay2: '6 May 2025', lastTbTestType: 'Whole herd test',
    riskArea: 'High', testInterval: 'Annual',
    nextSkinTest: 'May 2026', nextSkinTestOverdue: true,
    vaccinationStatus: 'Not vaccinated', vaccinationBooster: 'Not due'
  },
  // Riverside Farm – 300 + 130 + 82 cattle, mixed
  '12/352/6808': {
    bulls: 14, type: 'Mixed', contact: 'Olivia Riverstone', phone: '07203 188 446',
    lastTbTestDay2: '2 February 2025', lastTbTestType: 'Check test',
    lastWholeHerdTestDay2: '8 October 2024',
    riskArea: 'Edge', testInterval: 'Annual',
    nextSkinTest: 'February 2026', nextSkinTestOverdue: true,
    vaccinationStatus: 'Mixed', vaccinationBooster: 'Due August 2026'
  }
}

function getV12FarmDetailsForCph(cph) {
  // Sub-holdings share the main holding's briefing – the contact,
  // testing cadence and vaccination programme are operation-wide.
  const baseCph = String(cph || '').split('-')[0]
  return v12FarmDetails[cph] || v12FarmDetails[baseCph] || null
}

// FNV-1a style hash so the PRNG seed is deterministic per CPH.
function v11Hash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  }
  return h >>> 0
}

// Mulberry32 – a tiny, fast deterministic PRNG.
function v11Mulberry32(seed) {
  let state = seed >>> 0
  return function () {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function v11BuildAnimal(herdMark, checkDigit, individual, rng, farmIsVaccinated) {
  const officialId = `UK${herdMark}${checkDigit}${individual}`
  const breed = v11Breeds[Math.floor(rng() * v11Breeds.length)]
  const sex = rng() < 0.85 ? 'F' : 'M'
  // Age in months. Most active dairy/beef cattle sit between 12 and 72 months.
  // We sprinkle a few calves (3–11 months) and older animals (73–96 months).
  let ageMonths
  const r = rng()
  if (r < 0.15) {
    ageMonths = 3 + Math.floor(rng() * 9)          // calves
  } else if (r < 0.9) {
    ageMonths = 12 + Math.floor(rng() * 61)        // 1–6 years
  } else {
    ageMonths = 73 + Math.floor(rng() * 24)        // older
  }
  const dayOfBirth = 1 + Math.floor(rng() * 28)
  // Only farms listed in v11VaccinatedFarms have any vaccinated cattle;
  // within those farms we keep the ~75% vaccinated ratio so the herd still
  // contains a realistic mix of vaccinated and un-vaccinated animals.
  const vaccinationStatus = (farmIsVaccinated && rng() < 0.75)
    ? 'Vaccinated'
    : 'Not vaccinated'
  return {
    officialId,
    earTagNumber: officialId,
    barcode: officialId,
    breed,
    dob: formatDateForOffset(ageMonths, dayOfBirth),
    age: ageMonths,
    sex,
    vaccinationStatus,
    notes: ''
  }
}

function v11GenerateFarmHerd(cph, count) {
  // Sub-holdings (CPHs with a "-NN" suffix) inherit their parent CPH's
  // herd mark, check digit and vaccinated status – a sub-holding is part
  // of the same farm operation.
  const baseCph = cph.split('-')[0]
  const config = v11HerdMarks[cph] || v11HerdMarks[baseCph]
  if (!config || count <= 0) {
    return []
  }
  const herdMark = config.mark
  const checkDigit = config.check
  const rng = v11Mulberry32(v11Hash(cph))
  const farmIsVaccinated = v11VaccinatedFarms.has(cph) || v11VaccinatedFarms.has(baseCph)

  // Composition targets.
  // Each duplicate pair flags 2 animals on the farm (source + dup-edge copy),
  // so targeting duplicateCount ≈ 6–10% of the herd means at least 12% of
  // tags end up flagged as DUP – comfortably above the "≥ 5% per farm"
  // minimum, with a hard floor of 2 pairs even on very small herds.
  const boughtInCount = Math.round(count * (0.10 + rng() * 0.08))  // 10–18%
  const duplicateCount = Math.max(2, Math.round(count * (0.06 + rng() * 0.04))) // ≥2, 6–10%
  const outOfPlaceCount = count >= 60 ? 2 : (count >= 20 ? 1 : 0)
  const homeCount = Math.max(count - boughtInCount - duplicateCount - outOfPlaceCount, 0)

  const animals = []
  const usedTags = new Set()

  const tryPush = function (animal) {
    if (usedTags.has(animal.officialId)) return false
    usedTags.add(animal.officialId)
    animals.push(animal)
    return true
  }

  const otherMarks = Object.values(v11HerdMarks).filter(m => m.mark !== herdMark)
  const oddMarks = [
    { mark: '001020', check: '0' },
    { mark: '999888', check: '9' }
  ]

  // Home-born animals – near-sequential individual numbers with small gaps.
  let next = 1 + Math.floor(rng() * 80)           // starting offset
  let safety = 0
  while (animals.length < homeCount && safety < homeCount * 4) {
    next += 1 + Math.floor(rng() * 3)             // gap of 1–3
    const individual = String(next).padStart(5, '0')
    tryPush(v11BuildAnimal(herdMark, checkDigit, individual, rng, farmIsVaccinated))
    safety++
  }

  // Bought-in animals – different herd marks, random individual numbers.
  let boughtAdded = 0
  safety = 0
  while (boughtAdded < boughtInCount && safety < boughtInCount * 4) {
    const other = otherMarks[Math.floor(rng() * otherMarks.length)]
    const individual = String(1 + Math.floor(rng() * 99999)).padStart(5, '0')
    if (tryPush(v11BuildAnimal(other.mark, other.check, individual, rng, farmIsVaccinated))) {
      boughtAdded++
    }
    safety++
  }

  // Duplicate-ending – share the FULL last 5 digits (the individual number)
  // of an existing animal, using a different herd mark. Matching the entire
  // individual number means the pair appears adjacent when the list is
  // sorted by "Ear tag number (last 5 digits)", which is the sort vets will
  // use on the farm. Detection still catches last-4 matches, so this is a
  // strict subset of duplicates; pairs naturally satisfy both rules.
  const pool = animals.slice()
  const usedSources = new Set()
  let dupAdded = 0
  safety = 0
  while (dupAdded < duplicateCount && pool.length && safety < duplicateCount * 10) {
    const source = pool[Math.floor(rng() * pool.length)]
    safety++
    if (usedSources.has(source.officialId)) continue    // don't reuse a source
    const sourceMark = source.officialId.slice(2, 8)
    // Pick a herd mark that is neither the home mark (already excluded in
    // otherMarks) nor the source animal's own mark (otherwise we'd rebuild
    // source exactly).
    const candidates = otherMarks.filter(m => m.mark !== sourceMark)
    if (!candidates.length) continue
    const other = candidates[Math.floor(rng() * candidates.length)]
    const individual = source.officialId.slice(-5)      // full last-5 match
    if (tryPush(v11BuildAnimal(other.mark, other.check, individual, rng, farmIsVaccinated))) {
      dupAdded++
      usedSources.add(source.officialId)
    }
  }

  // Out-of-place animals
  for (let i = 0; i < outOfPlaceCount; i++) {
    const odd = oddMarks[i % oddMarks.length]
    const individual = String(Math.floor(rng() * 99999)).padStart(5, '0')
    tryPush(v11BuildAnimal(odd.mark, odd.check, individual, rng, farmIsVaccinated))
  }

  // Top up with extra home animals if we're short (e.g. collision retries).
  safety = 0
  while (animals.length < count && safety < count * 4) {
    next += 1 + Math.floor(rng() * 3)
    const individual = String(next).padStart(5, '0')
    tryPush(v11BuildAnimal(herdMark, checkDigit, individual, rng, farmIsVaccinated))
    safety++
  }

  // Shuffle so bought-in and duplicate-edge animals are mixed through the list.
  for (let i = animals.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = animals[i]
    animals[i] = animals[j]
    animals[j] = tmp
  }

  // Per-farm vaccination overrides. Mill House Farm is a fully BCG
  // vaccinated herd – mark every animal as Vaccinated so the prepare-
  // list flow defaults to DIVA on this farm. We also force five young
  // calves up the front of the list: three 1-month-olds and one each
  // at 2 and 3 months, so the prepare-list flow has plenty of cattle
  // the vet would mark as too young to test.
  if (baseCph === '12/312/6802') {
    animals.forEach(function (a) { a.vaccinationStatus = 'Vaccinated' })
    const calfAges = [1, 1, 1, 2, 3]
    for (let i = 0; i < animals.length && i < calfAges.length; i++) {
      const ageMonths = calfAges[i]
      animals[i].age = ageMonths
      animals[i].dob = formatDateForOffset(ageMonths, 14)
    }
  }

  return animals.slice(0, count)
}

function buildV11Dataset() {
  const result = {}
  Object.keys(herdData).forEach(function (cph) {
    const count = Number(herdData[cph].cattle) || 0
    result[cph] = v11GenerateFarmHerd(cph, count)
  })
  return result
}

// Build the v1-1 dataset once at module load time.
const v11AnimalsByCph = buildV11Dataset()

// v1-2 dataset: same as v1-1 except for per-farm overrides where v1-2
// has diverged. Mill House Farm in v1-2 marks a hand-picked set of
// cattle as BCG vaccinated (so they land on the DIVA list); every
// other animal on the farm is unvaccinated and goes on the SICCT list.
// Match is by the visible last-4 digits of the ear tag, which is what
// the demo notes refer to. Each vaccinated animal also gets a
// month/year (MM/YY) for when it was BCG-vaccinated, spread across
// 2024 and 2025 so the vet sees a realistic mix on the printed list.
//
// A few unvaccinated animals also have their DOB overridden to be
// under 44 days old so the "Check age" remark on the printed
// skin-test list has something to flag. The dates below are anchored
// to the prototype's demo date (early May 2026); update them if the
// demo is moved on.
const v12AnimalsByCph = Object.assign({}, v11AnimalsByCph)
if (v12AnimalsByCph['12/312/6802']) {
  const millHouse = v11AnimalsByCph['12/312/6802']
  // Mill House Farm is now a DIVA-only herd – every animal is BCG
  // vaccinated, so the auto-setup flow derives prepareSkinTestType
  // to 'DIVA' and the skin-test journey skips both the first-test
  // picker and the SICCT loop. The 38-animal herd splits across
  // three vaccination windows so the printed Eligibility column
  // shows a realistic mix:
  //   - 8  recently vaccinated cattle (indices 0–7)    → "Vaccinated"
  //                                                       (1–9 months
  //                                                       ago, inside
  //                                                       the 46-week
  //                                                       protection
  //                                                       window).
  //   - 5  cattle vaccinated 10–11 months ago (8–12)   → "Revaccination
  //                                                       due DD/MM/YYYY"
  //                                                       (over 46 weeks
  //                                                       but inside the
  //                                                       calendar year).
  //   - 25 overdue cattle (indices 13–37)               → "Revaccination
  //                                                       overdue"
  //                                                       (vaccinated
  //                                                       12+ months
  //                                                       ago).
  // Dates are anchored to the prototype's demo date (early May 2026).
  const recentVaxDates = ['08/25', '11/25', '02/26', '04/26']
  const dueVaxDates = ['06/25', '07/25']
  const overdueVaxDates = ['03/25', '04/25', '05/25']
  const recentlyVaccinatedCount = 8
  const dueCount = 5
  v12AnimalsByCph['12/312/6802'] = millHouse.map(function (a, idx) {
    if (idx < recentlyVaccinatedCount) {
      return Object.assign({}, a, {
        vaccinationStatus: 'Vaccinated',
        vaccinationDate: recentVaxDates[idx % recentVaxDates.length]
      })
    }
    const offset = idx - recentlyVaccinatedCount
    if (offset < dueCount) {
      return Object.assign({}, a, {
        vaccinationStatus: 'Vaccinated',
        vaccinationDate: dueVaxDates[offset % dueVaxDates.length]
      })
    }
    const overdueOffset = offset - dueCount
    return Object.assign({}, a, {
      vaccinationStatus: 'Vaccinated',
      vaccinationDate: overdueVaxDates[overdueOffset % overdueVaxDates.length]
    })
  })
}

// ---------------------------------------------------------------------
// The V5 research herd. Mill House at 102 animals, composed to exercise
// every path the SICCT sheet can take, with each animal's role fixed
// here instead of left to the demo generator's dice - a research sheet
// has to hold exactly what the brief says it holds.
//
//   10  reactor                       R on the sheet
//    1  inconclusive                  IR
//   20  reaction, still negative      bovine up 1-2mm, no result
//    2  not eligible - tested < 60 days ago
//    2  not eligible - under age      (asterisk in Notes)
//   20  not presented                 crossed out, "missing"
//    1  dead
//    2  missing on day 2              part test
//   44  clear
//  ---
//  102
//
// Scoped to v1-4 and v1-5. v1-1, v1-2 and v1-3 keep the 38-animal herd
// they have always had.
// Roles that mean "no readings at all" map onto the not-tested notes the
// demo generator already writes.
const V5_NOT_TESTED_ROLES = {
  'not-presented': 'not-found',
  'dead': 'deceased',
  'recent-test': 'recent-test',
  'under-age': 'under-age'
}

// The two rules the ineligible animals on this sheet exist to show:
// cattle under 42 days old cannot be skin tested, and cattle tested
// within the last 60 days cannot be tested again. Both are rules about
// dates, so the herd has to carry real ones. An animal labelled "too
// young" whose date of birth is two years ago teaches a vet nothing, and
// the service's own 42-day check would disagree with the label on the
// page - which is the one thing a research prototype must not do.
//
// Days back from today rather than fixed dates, so the herd stays true
// whenever the kit is started, and comfortably inside their limits so a
// long-running instance does not drift past them.
const V5_UNDER_AGE_DAYS = [11, 26]    // both under the 42-day minimum
const V5_RECENT_TEST_DAYS = [16, 38]  // both inside the 60-day interval

function v5DaysAgo (days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  const pad = function (n) { return n < 10 ? '0' + n : String(n) }
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear()
}

const V5_HERD_SIZE = 102
const V5_ROLE_PLAN = [
  { role: 'reactor', count: 10 },
  { role: 'inconclusive', count: 1 },
  { role: 'reaction', count: 20 },
  { role: 'recent-test', count: 2 },
  { role: 'under-age', count: 2 },
  { role: 'not-presented', count: 20 },
  { role: 'dead', count: 1 },
  { role: 'missing-day-2', count: 2 }
]

// Spread the roles through the list rather than clumping them, so the
// vet meets reactors and gaps all the way down the sheet the way they
// would on a real visit. Deterministic: the same herd every time.
function v5AssignRoles (animals) {
  const total = animals.length
  const slots = []
  V5_ROLE_PLAN.forEach(function (entry) {
    for (let i = 0; i < entry.count; i++) slots.push(entry.role)
  })
  // A fixed-step walk through the list. The step is coprime with 102, so
  // it visits every position exactly once before repeating.
  const step = 7
  let pos = 3
  const taken = {}
  slots.forEach(function (role) {
    while (taken[pos % total]) pos++
    const at = pos % total
    taken[at] = true
    animals[at].demoRole = role
    pos += step
  })
  animals.forEach(function (a) { if (!a.demoRole) a.demoRole = 'clear' })
  return animals
}

// Give the two ineligible pairs the record that makes them ineligible,
// rather than only the handwritten note saying they are.
function v5ApplyEligibilityDates (animals) {
  let ageIdx = 0
  let testIdx = 0
  animals.forEach(function (a) {
    // This herd states its own test history, so the demo's hash-based
    // frequent-flyer marker stays out of it - see recentTestFor.
    a.recentTestFixed = true
    if (a.demoRole === 'under-age') {
      a.dob = v5DaysAgo(V5_UNDER_AGE_DAYS[ageIdx % V5_UNDER_AGE_DAYS.length])
      ageIdx++
    } else if (a.demoRole === 'recent-test') {
      a.recentTestDate = v5DaysAgo(V5_RECENT_TEST_DAYS[testIdx % V5_RECENT_TEST_DAYS.length])
      a.recentTestType = 'SICCT'
      testIdx++
    }
  })
  return animals
}

const v14AnimalsByCph = Object.assign({}, v12AnimalsByCph)
if (v14AnimalsByCph['12/312/6802']) {
  const big = v11GenerateFarmHerd('12/312/6802', V5_HERD_SIZE).map(function (a) {
    // The V5 journey is SICCT, so the herd is unvaccinated - the DIVA
    // split that v1-2 needs does not apply here.
    return Object.assign({}, a, { vaccinationStatus: 'Not vaccinated', vaccinationDate: '' })
  })
  v14AnimalsByCph['12/312/6802'] = v5ApplyEligibilityDates(v5AssignRoles(big))
}

// Helper: parse an MM/YY vaccination date string and return how many
// whole months ago it was, relative to a reference date (defaults to
// today). Returns null if the input is missing or unparseable.
function monthsSinceVaxDate(mmYY, referenceDate) {
  if (!mmYY || typeof mmYY !== 'string') return null
  const parts = mmYY.split('/')
  if (parts.length !== 2) return null
  const month = parseInt(parts[0], 10)
  const year2 = parseInt(parts[1], 10)
  if (isNaN(month) || isNaN(year2)) return null
  const fullYear = year2 < 100 ? 2000 + year2 : year2
  const ref = referenceDate || new Date()
  return (ref.getFullYear() - fullYear) * 12 + ((ref.getMonth() + 1) - month)
}

function getAnimalsForSelection(selectedCattle, version) {
  // v1-3, v1-4 and v1-5 draw on the 102-animal research herd - the three
  // journeys in the comparison, on one set of cattle, because a
  // difference between them is only readable if the data underneath is
  // the same. v1-0 to v1-2 keep the herds they have always had, and so
  // does every farm in v1-3 other than the one overridden here.
  if ((version === 'v1-3' || version === 'v1-4' || version === 'v1-5')
    && v14AnimalsByCph[selectedCattle]) {
    return v14AnimalsByCph[selectedCattle]
  }
  if ((version === 'v1-2' || isV13Plus(version)) && v12AnimalsByCph[selectedCattle]) {
    return v12AnimalsByCph[selectedCattle]
  }
  if ((version === 'v1-1' || (version === 'v1-2' || isV13Plus(version))) && v11AnimalsByCph[selectedCattle]) {
    return v11AnimalsByCph[selectedCattle]
  }

  // V1-0 behaviour – unchanged.
  const herd = herdData[selectedCattle] || herdData['12/345/6789']
  const cattleCount = Number(herd.cattle) || 0
  const seedAnimals = baseAnimalData[selectedCattle] || []

  return Array.from({ length: cattleCount }, function (_, index) {
    if (seedAnimals[index]) {
      return seedAnimals[index]
    }

    return createGeneratedAnimal(selectedCattle || herd.cph, index)
  })
}

function normaliseFields(fields) {
  let selectedFields = fields || []

  if (!Array.isArray(selectedFields)) {
    selectedFields = [selectedFields]
  }

  return selectedFields.filter(field => field && field !== '_unchecked')
}

function getSortValue(animal, sortBy) {
  switch (sortBy) {
    case 'Age':
    case 'Age (youngest to oldest)':
      // Sort by months-from-dob so the order matches what's displayed
      // in the Age column. The stored animal.age field is set at
      // generation time and drifts as today's date moves on, which
      // produced ties / mis-ordering against the displayed value.
      return ageInMonthsFromDob(animal.dob)
    case 'Vaccination status':
      return animal.vaccinationStatus || ''
    case 'Ear-tag number':
      return animal.earTagNumber || ''
    case 'Ear-tag number (last 5 digits)':
      // Sort by the last 5 digits of the ear tag (the "individual" portion)
      return String(animal.earTagNumber || '').slice(-5)
    case 'Sex':
      return animal.sex || ''
    case 'Breed':
      return animal.breed || ''
    case 'DOB':
      return animal.dob || ''
    default:
      return animal.earTagNumber || ''
  }
}

// Frequent-flyer marker: an animal was tested on another farm within
// the last 60 days. Derived from a stable FNV-1a hash of the ear tag so
// the same animals are flagged everywhere (printed list, untested
// picker) without storing extra state. Returns { date, type } for a
// marked animal, or null. A real service would read this from CTS test
// history rather than hashing the ear tag.
function frequentFlyerRecentTest(officialId, phase, relative) {
  let fh = 2166136261
  const fid = String(officialId)
  for (let k = 0; k < fid.length; k++) { fh ^= fid.charCodeAt(k); fh = Math.imul(fh, 16777619) >>> 0 }
  if (fh % 16 !== 5) return null
  const g = Math.imul(fh ^ 0x9e3779b9, 2654435761) >>> 0
  // Same spread of "a while ago but still inside the interval", but as
  // days back from today rather than as dates that go stale.
  const date = relative
    ? v5DaysAgo([9, 15, 21, 27, 33, 39, 45, 51, 56][g % 9])
    : ['05/06', '18/06', '29/06', '05/07', '11/07', '18/07', '22/07', '25/07', '29/07'][g % 9] + '/2026'
  const type = phase === 'diva' ? 'DIVA' : 'SICCT'
  return { date: date, type: type }
}

// One place that answers "when was this animal last tested elsewhere?".
// A herd that carries its own test history answers for itself, including
// answering "no" - which the hash above cannot do, because it marks
// roughly one animal in sixteen wherever it is asked. A herd composed to
// contain exactly two recently-tested cattle would otherwise pick up
// half a dozen more.
function recentTestFor (animal, phase, relative) {
  if (!animal) return null
  if (animal.recentTestDate) {
    return { date: animal.recentTestDate, type: animal.recentTestType || 'SICCT' }
  }
  if (animal.recentTestFixed) return null
  return frequentFlyerRecentTest(animal.officialId, phase, relative)
}

// Numeric months-since-birth from a UK-formatted dob (DD/MM/YYYY).
// Used as the sort key for the Age column so stable, equal display
// values (e.g. two animals shown as "5M") sort in a deterministic
// younger-first order based on the underlying days-of-the-month.
function ageInMonthsFromDob(dob) {
  if (!dob || typeof dob !== 'string') return -1
  const parts = dob.split('/')
  if (parts.length !== 3) return -1
  const [day, month, year] = parts.map(Number)
  const birthDate = new Date(year, month - 1, day)
  if (Number.isNaN(birthDate.getTime())) return -1
  const today = new Date()
  // Days-since-birth gives a strictly monotonic key – two animals
  // displayed as the same number of months still sort in birth-date
  // order (older animal first when sorting youngest → oldest is
  // ascending, the opposite when descending).
  const msPerDay = 1000 * 60 * 60 * 24
  return Math.floor((today - birthDate) / msPerDay)
}

// True when a "MM/YY" vaccination date is within the last 12 months
// of the demo's "today" – used by the v1-2 vaccination list to flag
// animals whose existing vaccination is still inside the annual
// booster window so the vet checks the date before vaccinating again.
function isVaccinationWithinOneYear(vaxDateMmYy) {
  if (!vaxDateMmYy || typeof vaxDateMmYy !== 'string') return false
  const parts = vaxDateMmYy.split('/')
  if (parts.length !== 2) return false
  const month = parseInt(parts[0], 10)
  const year = 2000 + parseInt(parts[1], 10)
  if (Number.isNaN(month) || Number.isNaN(year)) return false
  if (month < 1 || month > 12) return false
  // Use the first day of the vaccination month so a vaccination given
  // in (e.g.) Feb 2026 still reads as "given in February" right up to
  // the end of February.
  const vaxDate = new Date(year, month - 1, 1)
  const today = new Date()
  const oneYearAgo = new Date(
    today.getFullYear() - 1,
    today.getMonth(),
    today.getDate()
  )
  return vaxDate >= oneYearAgo
}

function sortAnimals(animals, sortBy, sortDirection) {
  const direction = sortDirection === 'desc' ? -1 : 1

  return [...animals].sort((a, b) => {
    const aValue = getSortValue(a, sortBy)
    const bValue = getSortValue(b, sortBy)

    if (typeof aValue === 'number' && typeof bValue === 'number') {
      return (aValue - bValue) * direction
    }

    return String(aValue).localeCompare(String(bValue)) * direction
  })
}

function getFieldValue(animal, field) {
  switch (field) {
    case 'Age':
    case 'Age (youngest to oldest)':
      return calculateAgeFromDob(animal.dob)
    case 'Vaccination status':
      return ''
    case 'Ear-tag number':
      return animal.earTagNumber || ''
    case 'Sex':
      return animal.sex || ''
    case 'Breed':
      return animal.breed || ''
    case 'DOB':
      return animal.dob || ''
    default:
      return ''
  }
}

function orderPreviewFields(fields) {
  const selectedFields = normaliseFields(fields).filter(field => field !== 'Ear-tag number')
  const ordered = availableListColumns.filter(field => selectedFields.includes(field))
  const vaccinationField = ordered.find(field => field === 'Vaccination status')
  const remainingFields = ordered.filter(field => field !== 'Vaccination status')

  return vaccinationField ? [...remainingFields, vaccinationField] : remainingFields
}

function buildPreviewColumns(fields) {
  return orderPreviewFields(fields)
}

function formatEarTagParts(officialId) {
  const cleaned = String(officialId || '').replace(/\s+/g, '').replace(/^UK/i, '')

  return {
    prefix: 'UK',
    herd: cleaned.slice(0, 6),
    check: cleaned.slice(6, 7),
    // `individual` remains the full 5-digit individual number for any
    // legacy consumer. New code should use `individualStart` (the first
    // digit) + `last4` (the last 4 digits) so the highlight can sit on
    // just the last 4 without a visual gap before it.
    individual: cleaned.slice(7, 12),
    individualStart: cleaned.slice(7, 8),
    last4: cleaned.slice(-4)
  }
}

// Short, human-style ways a vet scribbles WHY an animal was not tested,
// written in the Notes column with no Pre/Post measurements. Several
// phrasings per reason so the sheet reads like different people wrote it,
// often shortened (e.g. "deceased" -> "dead").
const NOT_TESTED_NOTES = {
  'not-found': ['not found', 'n/f', 'not present', 'absent', 'couldn’t find', 'not seen'],
  'deceased': ['deceased', 'dead', 'died', 'dead'],
  'export': ['w/d - export', 'exported', 'for export', 'sold (export)'],
  'slaughter': ['w/d - slaughter', 'for slaughter', 'cull', 'slaughtered'],
  'owner': ['w/d by owner', 'owner removed', 'removed by owner', 'owner w/d'],
  // Not eligible to test. The vet still rules the row out, but the reason
  // is the animal's record rather than anything that happened at the
  // crush - so the wording says why it could not be tested at all.
  'recent-test': ['tested < 60d', 'SICCT 60d', 'recent test', 'tested recently'],
  'under-age': ['too young', 'under age', 'u/age', 'too young to test']
}

// Build deterministic "handwritten" demo answers for one animal, used by
// the populated-list print view. Same ear tag always yields the same
// readings, so a populated list is stable between prints. Returns ready-
// made HTML spans (Indie Flower handwriting) for each measurement cell.
function buildDemo (officialId, opts) {
  opts = opts || {}
  let h = 2166136261
  const sid = String(officialId)
  for (let i = 0; i < sid.length; i++) { h ^= sid.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  const rnd = function (n) { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return Math.floor((h / 4294967296) * n) }
  const span = function (v, smudge, scatter, size) {
    const rot = rnd(11) - 5
    const tf = scatter
      ? 'transform:translate(' + (rnd(7) - 3) + 'px,' + (rnd(5) - 2) + 'px) rotate(' + rot + 'deg);'
      : 'transform:rotate(' + (rnd(7) - 3) + 'deg);'
    const cls = 'app-hand' + (smudge ? ' app-smudge-' + smudge : '')
    const sz = size ? 'font-size:' + size + 'px;' : ''
    return '<span class="' + cls + '" style="' + tf + sz + '">' + v + '</span>'
  }
  // Pen marks on the "#" column. On a real sheet the vet ticks the row
  // number once the animal has been handled, and crosses the number out
  // when it is not going to be tested at all - so the number column doubles
  // as the vet's own progress check down the list.
  // Opt-in: only the V5 list renders these, so v1-0 to v1-3 are unchanged.
  const penMarks = !!opts.penMarks
  const tickMark = function () {
    if (!penMarks) return ''
    // Leaning the natural way for a right-handed tick, bottom-left up to
    // top-right. The stroke pivots on its left edge (see .app-hand-tick),
    // so the angle changes the lean without pushing ink back over the
    // number.
    return '<span class="app-num-tick-anchor"><span class="app-hand app-hand-tick" style="transform:rotate(' + (rnd(19) - 8) + 'deg);">\u2713</span></span>'
  }
  // Not tested: one long stroke straight across the whole row, the way a
  // vet rules a line through an animal they are not going to test. Drawn
  // from the "#" cell and allowed to overhang the rest of the row, with a
  // fraction of a degree of tilt so it reads as pen rather than rule.
  const crossOut = function () {
    if (!penMarks) return ''
    // A whole degree of tilt sounds like nothing, but the stroke is ~800px
    // long, so it dropped one end by 14px and read as a sloping line
    // rather than a ruled one. A few tenths is enough to stop it looking
    // like a border.
    const tilt = ((rnd(9) - 4) / 10)
    // Percentage of the animal's row group. The writing is vertically
    // centred over the A/B pair and sits at roughly 55% once the header
    // rows are allowed for, so the stroke is scattered around that.
    const drop = 50 + rnd(9)
    return '<span class="app-row-strike" style="top:' + drop + '%;transform:rotate(' + tilt + 'deg);"></span>'
  }

  // The reference a vet writes in Notes against a reactor - three digits,
  // stable per animal so a reprinted list shows the same number.
  const reactorRef = function () {
    if (!penMarks) return ''
    return '<span class="app-hand app-hand-note app-hand-ref">' + (100 + rnd(900)) + '</span>'
  }

  // A word started and crossed out (someone changed their mind mid-note).
  const struckWord = function (w) {
    return '<span class="app-hand app-struck app-hand-struck-note">' + w + '</span>'
  }
  // Occasional smudged number (light, or heavy/illegible) - applied to the
  // Pre / Post / Reaction desc numbers, never to the overall result.
  const cellSmudge = function () { return (rnd(7) === 0) ? (1 + rnd(2)) : 0 }
  // A crossed-out mis-write: the wrong value sits in the middle of the box
  // struck through, and the correct value is squeezed in small at the
  // corner (there's no room for it). The old number gets 1-4 cross-out
  // strokes at varied angles - the more strokes (3+), the more it's also
  // blurred, so it's barely legible.
  const correction = function (value) {
    let d = rnd(5) - 2
    if (d === 0) d = 1
    const wrong = Math.max(1, value + d)
    const strokes = 1 + rnd(4)
    let lines = ''
    for (let i = 0; i < strokes; i++) {
      lines += '<span class="app-strike-line" style="top:' + (26 + rnd(44)) + '%;transform:rotate(' + (rnd(23) - 11) + 'deg);"></span>'
    }
    const heavy = strokes >= 3 ? ' app-correct__old--heavy' : ''
    return '<span class="app-correct">' +
      '<span class="app-hand app-correct__old' + heavy + '" style="transform:rotate(' + (rnd(9) - 4) + 'deg);">' + wrong + lines + '</span>' +
      '<span class="app-hand app-correct__new" style="transform:rotate(' + (rnd(13) - 6) + 'deg);">' + value + '</span>' +
      '</span>'
  }
  // A Pre / Post number: about 1 in 5 is a crossed-out correction, the rest
  // a plain (sometimes lightly smudged) number. Corrections are only applied
  // to cells that don't feed a shown "C +N" reaction, so this rate keeps at
  // least 10% of all Pre/Post numbers crossed out and rewritten.
  const preOrPost = function (value) {
    return (rnd(5) === 0) ? correction(value) : span(value, cellSmudge(), true)
  }
  // Animal not tested (not found / deceased / withdrawn). No Pre/Post
  // measurements, just a short handwritten reason in Notes.
  if (opts.forceNotTested) {
    const phrases = NOT_TESTED_NOTES[opts.forceNotTested] || ['not tested']
    return {
      filled: true, notTested: true,
      num: crossOut(),
      aPre: '', aPost: '', aR: '', bPre: '', bPost: '', bR: '', res: '',
      note: '<span class="app-hand app-hand-note">' + phrases[rnd(phrases.length)] + '</span>'
    }
  }
  const aPre = 4 + rnd(5)
  const bPre = 4 + rnd(5)
  // forceM2 -> part test; forceReactor -> a reactor result.
  const roll = (opts.role === 'missing-day-2' || opts.forceM2)
    ? 0
    : (opts.forceReactor ? 20 : rnd(100))
  // The 6% random part test only applies to a herd that has not been
  // composed. With roles set, only the animals given that role take this
  // branch - otherwise five rows came out as part tests where two were
  // asked for.
  if (roll < 6 && (!opts.role || opts.role === 'missing-day-2')) {
    // Injected on day 1, not read on day 2 (part test). Vary the wording -
    // people write it differently.
    const missPhrases = ['missing', 'miss day 2', 'no D2', 'not read D2', 'missing D2', 'didn’t read']
    return { filled: true, num: tickMark(), aPre: preOrPost(aPre), aPost: '', aR: '', bPre: preOrPost(bPre), bPost: '', bR: '', res: '', note: '<span class="app-hand app-hand-note">' + missPhrases[rnd(missPhrases.length)] + '</span>' }
  }
  // A role pins the avian reading flat, so the bovine increase alone
  // decides the outcome - which is how the composition in V5_ROLE_PLAN
  // stays exactly what it says it is.
  const aPost = opts.role ? aPre : aPre + rnd(3)
  // A vet who measures no change at 72 hours often leaves the Post box
  // empty rather than writing the same number twice - the blank IS the
  // reading. Only ever applied where the increase is zero, so it can never
  // break the arithmetic on a row that shows a reaction.
  const blankIfNoIncrease = function (pre, post, html) {
    if (!penMarks) return html
    if (post - pre !== 0) return html
    // Most of the time the vet writes nothing: the blank is the reading.
    // Some write a dash to show they did look. A few write the number
    // out again.
    const r = rnd(10)
    if (r < 6) return ''
    if (r < 9) return span('-', 0, true)
    return html
  }
  let bPost
  if (opts.role === 'reactor') bPost = bPre + 6 + rnd(6)      // +6..11 -> R
  else if (opts.role === 'inconclusive') bPost = bPre + 4      // +4      -> IR
  else if (opts.role === 'reaction') bPost = bPre + 1 + rnd(2) // +1..2   -> still negative
  else if (opts.role === 'clear') bPost = bPre                 // no change
  else if (roll < 26) bPost = bPre + 6 + rnd(8)          // reactor (~20%)
  else if (roll < 32) bPost = bPre + (aPost - aPre) + 1 // inconclusive
  else bPost = bPre + rnd(2)                          // clear
  const aInc = aPost - aPre
  const bInc = bPost - bPre
  const diff = bInc - aInc
  // The TB64 rule the service applies, not a shorthand. The old rule
  // here was `diff >= 2 ? R : diff === 1 ? IR : ''`, which disagreed with
  // the service on five of eleven common readings - a bovine rise of 2mm
  // with no avian change printed "R" on the paper and came out negative
  // on screen. On a sheet whose whole purpose is to be transcribed and
  // checked against the service, that is the worst possible bug.
  const bovinePositive = bInc > 2
  const avianPositive = aInc > 2
  let res = ''
  if (bovinePositive && !(avianPositive && diff <= 0)) {
    res = diff > 4 ? 'R' : 'IR'
  }
  // Whether this row shows a calculated "C +N" reaction description. When it
  // does, the Pre/Post numbers that feed it are kept as clean written values
  // (no crossed-out correction) so the arithmetic on the sheet adds up.
  const aRShown = aInc >= 2
  const bRShown = bInc >= 2
  let bPostHtml
  if (opts.forceHeavyBlur) {
    // A fully blurred (illegible) reactor measurement.
    bPostHtml = span(bPost, 2, true)
  } else if (bRShown) {
    // Keep Post clean so bPost - bPre matches the "C +N" shown for the row.
    bPostHtml = span(bPost, cellSmudge(), true)
  } else {
    bPostHtml = preOrPost(bPost)
  }
  // A few animals have a half-written, crossed-out word in Notes.
  let note = ''
  if (rnd(9) === 0) {
    const frags = ['re', 'inc', 'poss', 'no re', 'cl', 'check', 'susp']
    note = struckWord(frags[rnd(frags.length)])
  }
  // Only an animal actually taken as a reactor is tagged, so only a
  // reactor has a reference to write in Notes. An inconclusive animal is
  // left in place for a re-test and never gets one.
  //
  // Older lists carry it for both, and are left as they are - see the
  // note on the opt at the call site.
  if (opts.refOnlyForReactor ? res === 'R' : !!res) {
    note += reactorRef()
  }
  return {
    filled: true,
    num: tickMark(),
    // Vets only note a reaction description where there's a real reaction;
    // "C +0" and 1mm blips are left blank.
    aPre: aRShown ? span(aPre, cellSmudge(), true) : preOrPost(aPre),
    aPost: aRShown ? span(aPost, cellSmudge(), true) : blankIfNoIncrease(aPre, aPost, preOrPost(aPost)),
    aR: aRShown ? span('C +' + aInc, cellSmudge(), true) : '',
    bPre: bRShown ? span(bPre, cellSmudge(), true) : preOrPost(bPre),
    bPost: bRShown ? bPostHtml : blankIfNoIncrease(bPre, bPost, bPostHtml),
    bR: bRShown ? span('C +' + bInc, cellSmudge(), true) : '',
    res: res ? span(res, 0, false) : '', note: note
  }
}

// Extra cattle written into the blank "Additional cattle" sheet on a
// populated list - animals that were not on the printed list (bought in
// etc.). Returns ready-made handwritten HTML cells.
function buildExtraCattle (herdMark, count) {
  const breeds = ['HER', 'BF', 'SIM', 'BALX', 'CH', 'AAX', 'LIM', 'BB']
  const notes = ['not on list', 'bought in', '', 'new arrival', '', '']
  const out = []
  for (let i = 0; i < count; i++) {
    let h = 2166136261
    const seed = 'extra-' + herdMark + '-' + i
    for (let j = 0; j < seed.length; j++) { h ^= seed.charCodeAt(j); h = Math.imul(h, 16777619) >>> 0 }
    const rnd = function (n) { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return Math.floor((h / 4294967296) * n) }
    const span = function (v) {
      if (!v) return ''
      // Font size is set on the Additional cattle sheet via CSS
      // (.app-blank-sheet .app-hand), so only the rotation is inline here.
      return '<span class="app-hand" style="transform:rotate(' + (rnd(9) - 4) + 'deg);">' + v + '</span>'
    }
    const indiv = String(900000 + (i * 137 + rnd(90)) % 99999).slice(-6)
    const dd = String(1 + rnd(28)).padStart(2, '0')
    const mm = String(1 + rnd(12)).padStart(2, '0')
    const yyyy = 2019 + rnd(6)
    out.push({
      tag: span('UK ' + herdMark + ' ' + indiv, 15),
      dob: span(dd + '/' + mm + '/' + yyyy, 15),
      sex: span(rnd(2) ? 'F' : 'M', 15),
      breed: span(breeds[rnd(breeds.length)], 15),
      note: (function () { const nt = notes[rnd(notes.length)]; return nt ? '<span class="app-hand app-hand-note">' + nt + '</span>' : '' })()
    })
  }
  return out
}

function buildPreviewRows(animals, fields) {
  const selectedFields = orderPreviewFields(fields)

  return animals.map(animal => ({
    officialId: animal.officialId,
    barcode: animal.barcode,
    notes: animal.notes,
    earTagParts: formatEarTagParts(animal.officialId),
    cells: selectedFields.map(field => ({
      key: field,
      value: getFieldValue(animal, field)
    }))
  }))
}

function normalisePreviewOptions(options, fields) {
  const allFields = availableListColumns
  const submitted = Array.isArray(options) ? options : (options ? [options] : [])
  const filtered = submitted.filter(option => option && option !== '_unchecked')

  if (!filtered.length) {
    return ['show-last-five', ...allFields]
  }

  return filtered
}

function getPreviewSettings(sessionData, fields) {
  const allFields = availableListColumns
  const previewOptions = normalisePreviewOptions(sessionData.previewOptions, fields)
  const visibleColumns = allFields.filter(field => previewOptions.includes(field))

  return {
    previewTextSize: sessionData.previewTextSize || 'standard',
    previewOrientation: sessionData.previewOrientation || 'portrait',
    previewSpacing: sessionData.previewSpacing || 'standard',
    previewOptions,
    emphasiseLastFive: previewOptions.includes('show-last-five'),
    visibleColumns,
    allColumns: allFields
  }
}

function getReportingAnimals(req, version) {
  const selectedCattle = req.session.data.selectedCattle
  const sortBy = req.session.data.sortBy || 'Ear-tag number'
  const sortDirection = req.session.data.sortDirection || 'asc'
  const base = getAnimalsForSelection(selectedCattle, version)
  const added = getVaccinationAddedAnimals(req, version)
  return sortAnimals(base.concat(added), sortBy, sortDirection)
}

// v1-3: cattle the vet adds during the report because they weren't on
// the original list (for example a newly arrived animal). Stored in
// session and merged into the reporting herd so they flow through the
// marking groups, the confirmation summary and the check-your-answers
// page exactly like the seeded animals. Only v1-3 has the add-cattle
// step, so other versions always see an empty list.
function getVaccinationAddedAnimals(req, version) {
  if (!isV13Plus(version)) return []
  return Array.isArray(req.session.data.vaccinationAddedAnimals)
    ? req.session.data.vaccinationAddedAnimals
    : []
}

function getAnimalLookup(animals) {
  return animals.reduce((lookup, animal) => {
    lookup[animal.officialId] = animal
    return lookup
  }, {})
}

function getDecisionMap(sessionData) {
  return sessionData.cattleDecisions || {}
}

function getReportingGroups(animals, decisionMap) {
  const groups = {
    remaining: [],
    vaccinated: [],
    'not-found': [],
    deceased: [],
    'withdrawn-export': [],
    'withdrawn-slaughter': [],
    'withdrawn-owner': [],
    other: [],
    // 'no-reason' is the bulk-skip bucket – the vet has decided not
    // to record a specific reason for these animals. Reached via the
    // "Skip and mark as no reason given" link on the reasons phase
    // of /v1-2/select-vaccinated-animals.
    'no-reason': []
  }

  animals.forEach((animal) => {
    const decision = decisionMap[animal.officialId]

    if (decision && groups[decision]) {
      groups[decision].push(animal)
    } else {
      groups.remaining.push(animal)
    }
  })

  return groups
}

function getSummaryBuckets(groups) {
  return [
    { key: 'vaccinated', label: 'Vaccinated', count: groups.vaccinated.length },
    { key: 'not-found', label: 'Cattle not found', count: groups['not-found'].length },
    { key: 'deceased', label: 'Deceased', count: groups.deceased.length },
    { key: 'withdrawn-export', label: 'Withdrawn for export', count: groups['withdrawn-export'].length },
    { key: 'withdrawn-slaughter', label: 'Withdrawn for slaughter', count: groups['withdrawn-slaughter'].length },
    { key: 'withdrawn-owner', label: 'Withdrawn by owner', count: groups['withdrawn-owner'].length },
    { key: 'other', label: 'Other', count: groups.other.length },
    { key: 'no-reason', label: 'No reason given', count: (groups['no-reason'] || []).length }
  ].filter(bucket => bucket.count > 0)
}

function getGroupLabel(groupKey) {
  const labels = {
    remaining: 'Remaining cattle',
    vaccinated: 'Vaccinated',
    'not-found': 'Cattle not found',
    deceased: 'Deceased',
    'withdrawn-export': 'Withdrawn for export',
    'withdrawn-slaughter': 'Withdrawn for slaughter',
    'withdrawn-owner': 'Withdrawn by owner',
    other: 'Other',
    'no-reason': 'No reason given'
  }

  return labels[groupKey] || 'Remaining cattle'
}

function getRowsForReviewGroup(groups, groupKey, otherReasons) {
  switch (groupKey) {
    case 'vaccinated':
      return buildReportingTableRows(groups.vaccinated, otherReasons)
    case 'not-found':
      return buildReportingTableRows(groups['not-found'], otherReasons)
    case 'deceased':
      return buildReportingTableRows(groups.deceased, otherReasons)
    case 'withdrawn-export':
      return buildReportingTableRows(groups['withdrawn-export'], otherReasons)
    case 'withdrawn-slaughter':
      return buildReportingTableRows(groups['withdrawn-slaughter'], otherReasons)
    case 'withdrawn-owner':
      return buildReportingTableRows(groups['withdrawn-owner'], otherReasons)
    case 'other':
      return buildReportingTableRows(groups.other, otherReasons)
    case 'no-reason':
      return buildReportingTableRows(groups['no-reason'] || [], otherReasons)
    default:
      return buildReportingTableRows(groups.remaining, otherReasons)
  }
}

function calculateAgeFromDob(dob) {
  if (!dob || typeof dob !== 'string') {
    return ''
  }

  const parts = dob.split('/')
  if (parts.length !== 3) {
    return ''
  }

  const [day, month, year] = parts.map(Number)
  const birthDate = new Date(year, month - 1, day)

  if (Number.isNaN(birthDate.getTime())) {
    return ''
  }

  const today = new Date()

  if (birthDate > today) {
    return ''
  }

  const msPerDay = 1000 * 60 * 60 * 24
  const daysOld = Math.floor((today - birthDate) / msPerDay)

  let monthsOld = (today.getFullYear() - birthDate.getFullYear()) * 12
    + (today.getMonth() - birthDate.getMonth())

  if (today.getDate() < birthDate.getDate()) {
    monthsOld -= 1
  }

  let yearsOld = today.getFullYear() - birthDate.getFullYear()

  if (
    today.getMonth() < birthDate.getMonth() ||
    (today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate())
  ) {
    yearsOld -= 1
  }

  if (daysOld < 30) {
    return `${daysOld}D`
  }

  if (monthsOld < 12) {
    return `${Math.max(monthsOld, 1)}M`
  }

  return `${Math.max(yearsOld, 1)}Y`
}

function buildReportingTableRows(animals, otherReasons = {}) {
  return animals.map(animal => ({
    id: animal.officialId,
    officialId: animal.officialId,
    age: calculateAgeFromDob(animal.dob),
    breed: animal.breed,
    dob: animal.dob,
    sex: animal.sex,
    notes: animal.notes,
    otherReason: otherReasons[animal.officialId] || '',
    earTagParts: formatEarTagParts(animal.officialId),
    // Flags pre-computed in renderSelectVaccinatedAnimals so the
    // template can underline borderline DOBs / vax dates and mark
    // duplicates on the last-4 segment, matching the other v1-2
    // skin-test tables.
    isDuplicate: !!animal.isDuplicate,
    isUnderTestAge: !!animal.isUnderTestAge,
    isVaxCheckDue: !!animal.isVaxCheckDue,
    vaccinationDate: animal.vaccinationDate || ''
  }))
}

function buildSelectedAnimalSummary(animals, ids) {
  const selectedIds = Array.isArray(ids) ? ids : (ids ? [ids] : [])
  const idSet = new Set(selectedIds)

  return animals
    .filter(animal => idSet.has(animal.officialId))
    .map(animal => `${animal.officialId} – ${animal.breed} – ${animal.sex} – DOB ${animal.dob}`)
}

function renderSelectVaccinatedAnimals(req, res, version, options = {}) {
  // v1-2: lock the order on this page to ear-tag (last 5 digits) so it
  // matches the printed / on-screen lists, which always default to the
  // same key (req.session.data.skinTestSortBy → "Ear-tag number (last
  // 5 digits)"). Without this override the page would inherit whatever
  // generic req.session.data.sortBy happens to be (e.g. Age or DOB),
  // which would put the cattle in a different order from the list the
  // vet has already prepared.
  const rawAnimals = getAnimalsForSelection(req.session.data.selectedCattle, version)
    .concat(getVaccinationAddedAnimals(req, version))
  const baseAnimals = ((version === 'v1-2' || isV13Plus(version)))
    ? sortAnimals(rawAnimals, 'Ear-tag number (last 5 digits)', 'asc')
    : getReportingAnimals(req, version)
  // Pre-compute the borderline-flag set across the whole reporting
  // herd so duplicate / DOB-check / TB-Vax-check underlines render
  // consistently regardless of which review group the animal sits in.
  const lastFourCounts = {}
  baseAnimals.forEach(function (a) {
    const last4 = String(a.officialId || '').slice(-4)
    lastFourCounts[last4] = (lastFourCounts[last4] || 0) + 1
  })
  const animals = baseAnimals.map(function (a) {
    const last4 = String(a.officialId || '').slice(-4)
    const daysOld = ageInMonthsFromDob(a.dob)
    const isUnderTestAge = typeof daysOld === 'number'
      && daysOld >= 35
      && daysOld <= 49
    const vaxMonths = monthsSinceVaxDate(a.vaccinationDate)
    const isVaxCheckDue = typeof vaxMonths === 'number'
      && vaxMonths >= 8
      && vaxMonths <= 10
    return Object.assign({}, a, {
      isDuplicate: lastFourCounts[last4] > 1,
      isUnderTestAge: isUnderTestAge,
      isVaxCheckDue: isVaxCheckDue
    })
  })
  const decisionMap = getDecisionMap(req.session.data)
  const otherReasons = req.session.data.otherReasons || {}
  const groups = getReportingGroups(animals, decisionMap)
  const activeReviewGroup = req.session.data.activeReviewGroup || 'remaining'
  const markingPhase = req.session.data.markingPhase || 'vaccinated'
  const groupEditKeysView = [
    'vaccinated', 'not-found', 'deceased', 'withdrawn-export',
    'withdrawn-slaughter', 'withdrawn-owner', 'other', 'no-reason'
  ]
  const isGroupEditModel = groupEditKeysView.indexOf(activeReviewGroup) !== -1
  // Editing a banked group (vaccinated or a not-vaccinated reason, reached
  // via a "Change" link): show the WHOLE herd with the group's current
  // members pre-selected, so the vet can add or remove cattle from the
  // group in one view rather than only seeing the animals already in it.
  // Other views keep their filtered rows.
  const activeRows = isGroupEditModel
    ? buildReportingTableRows(animals, otherReasons)
    : getRowsForReviewGroup(groups, activeReviewGroup, otherReasons)
  const selectedIds = Array.isArray(options.selectedIds)
    ? options.selectedIds
    : (isGroupEditModel
        ? (groups[activeReviewGroup] || []).map(function (a) { return a.officialId })
        : [])

  return res.render(`${version}/select-vaccinated-animals`, {
    herd: req.session.data.herd || herdData[req.session.data.selectedCattle],
    activeRows,
    activeReviewGroup,
    activeReviewGroupLabel: getGroupLabel(activeReviewGroup),
    summaryBuckets: getSummaryBuckets(groups),
    totalAnimals: animals.length,
    totalRemaining: groups.remaining.length,
    totalMarked: animals.length - groups.remaining.length,
    allComplete: groups.remaining.length === 0,
    markingPhase,
    selectedIds,
    selectedAnimalSummary: buildSelectedAnimalSummary(animals, selectedIds),
    // Page size the vet chose on /v1-2/download-list (Easy = 20,
    // Compact = 40). The marking table renders a "Page N" divider
    // after every chunk of this many rows so the on-screen order
    // mirrors the printed-sheet boundaries.
    cattlePerPage: req.session.data.vaccinationCattlePerPage || 20,
    errors: options.errors,
    errorSummary: options.errorSummary,
    formValues: options.formValues || {}
  })
}

function buildActivePreviewTags(options) {
  const tags = []

  if (options.downloadFormat === 'csv') {
    tags.push('File format: CSV')
  } else {
    tags.push('File format: Printable list (PDF)')
  }

  if (options.downloadFormat !== 'csv' && options.previewTextSize && options.previewTextSize !== 'standard') {
    tags.push(`Text size: ${options.previewTextSize}`)
  }

  if (options.downloadFormat !== 'csv' && options.previewOrientation && options.previewOrientation !== 'portrait') {
    tags.push(`Orientation: ${options.previewOrientation}`)
  }

  if (options.downloadFormat !== 'csv' && options.previewSpacing && options.previewSpacing !== 'standard') {
    tags.push(`Line spacing: ${options.previewSpacing}`)
  }

  if (options.downloadFormat !== 'csv' && options.emphasiseLastFive) {
    tags.push('Last 5 digits emphasised')
  }

  options.visibleColumns.forEach(column => {
    tags.push(`Show: ${column === 'Age (youngest to oldest)' ? 'Age' : column}`)
  })

  return tags
}

// -----------------------------------------------------------------------------
// v1-2 removes the manual "Are the cattle vaccinated?" page and derives
// the skin-test type from the herd's vaccination status instead. This
// helper sets all of the session state that the prepare-skin-test-type
// POST handler used to set, so the rest of the journey – mark-untested,
// the assignment split, and the combined skin-test list – continues to
// work without any other code changes.
// -----------------------------------------------------------------------------
function autoSetupSkinTestForV12(req, version) {
  const selectedCattle = req.session.data.selectedCattle
  const animals = getAnimalsForSelection(selectedCattle, version)
  const hasVaccinated = animals.some(function (a) {
    return a.vaccinationStatus === 'Vaccinated'
  })
  const hasUnvaccinated = animals.some(function (a) {
    return a.vaccinationStatus !== 'Vaccinated'
  })

  let type = 'SICCT'
  if (hasVaccinated && hasUnvaccinated) type = 'Both'
  else if (hasVaccinated) type = 'DIVA'

  req.session.data.prepareSkinTestType = type
  req.session.data.prepareSkinTestUntested = []
  req.session.data.prepareSkinTestUntestedReasons = {}
  req.session.data.prepareSkinTestUntestedReasonOthers = {}
  req.session.data.currentPrepareUntestedIndex = 0
  req.session.data.prepareAssignMode = null
  req.session.data.prepareAssignFirstTest = null
  req.session.data.prepareAssignCurrentTest = null

  if (type === 'Both') {
    const sicct = animals
      .filter(function (a) { return a.vaccinationStatus !== 'Vaccinated' })
      .map(function (a) { return a.officialId })
    const diva = animals
      .filter(function (a) { return a.vaccinationStatus === 'Vaccinated' })
      .map(function (a) { return a.officialId })
    req.session.data.prepareSkinTestAssignments = { sicct: sicct, diva: diva }
    req.session.data.prepareAssignCompletedTests = ['sicct', 'diva']
    req.session.data.prepareSkinTestPhase = 'sicct'
  } else {
    req.session.data.prepareSkinTestAssignments = null
    req.session.data.prepareAssignCompletedTests = []
    req.session.data.prepareSkinTestPhase = type === 'SICCT' ? 'sicct' : 'diva'
  }
}

// -----------------------------------------------------------------------------
// Register routes for a given prototype version (e.g. 'v1-0', 'v1-1').
// All route paths and template paths are prefixed with the version.
// -----------------------------------------------------------------------------
function registerVersionRoutes(version) {
  // ---------------------------------------------------------------------------
  // Start and sign-in routes
  // ---------------------------------------------------------------------------
  router.get(`/${version}/sign-in`, (req, res) => {
    res.render(`${version}/sign-in`)
  })

  router.post(`/${version}/sign-in`, (req, res) => {
    const signInMethod = req.body.signInMethod

    if (!signInMethod) {
      return res.render(`${version}/sign-in`, {
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [
            {
              text: 'Select how you want to sign in',
              href: '#signInMethod'
            }
          ]
        },
        errors: {
          signInMethod: { text: 'Select how you want to sign in' }
        }
      })
    }

    if (signInMethod === 'one-login') {
      return res.redirect(`/${version}/one-login`)
    }

    return res.redirect(`/${version}/dashboard`)
  })

  // ---------------------------------------------------------------------------
  // Search routes
  // ---------------------------------------------------------------------------
  router.get(`/${version}/search`, (req, res) => {
    res.render(`${version}/search`)
  })

  router.post(`/${version}/search`, (req, res) => {
    handleFarmSearch(req, res, `${version}/search`, version)
  })

  router.get(`/${version}/search-for-a-herd-or-animal`, (req, res) => {
    res.render(`${version}/search-for-a-herd-or-animal`)
  })

  router.post(`/${version}/search-for-a-herd-or-animal`, (req, res) => {
    handleFarmSearch(req, res, `${version}/search-for-a-herd-or-animal`, version)
  })

  router.get(`/${version}/search-results`, (req, res) => {
    res.render(`${version}/search-results`)
  })

  router.get(`/${version}/confirm-herd-or-animal`, (req, res) => {
    const locals = {}
    // v1-1 / v1-2 show the TB status block – v1-0 template doesn't use it.
    if ((version === 'v1-1' || (version === 'v1-2' || isV13Plus(version))) && req.session.data.selectedCattle) {
      locals.tbStatus = getV11TbStatusForCph(req.session.data.selectedCattle)
      const animals = getAnimalsForSelection(req.session.data.selectedCattle, version)
      const vaccinated = animals.filter(function (a) {
        return a.vaccinationStatus === 'Vaccinated'
      })
      locals.vaccinatedCount = vaccinated.length
      locals.unvaccinatedCount = animals.length - vaccinated.length
      // "Overdue revaccination" = vaccinated 12+ months ago, i.e.
      // outside the 12-month booster window. Drives the vet briefing
      // on the herd page so they know how many cattle on the DIVA
      // side will be flagged for re-vaccination.
      const today = new Date()
      locals.overdueRevaccinationCount = vaccinated.filter(function (a) {
        const monthsSince = monthsSinceVaxDate(a.vaccinationDate, today)
        return typeof monthsSince === 'number' && monthsSince >= 12
      }).length
    }
    // v1-2 also renders the expanded farm briefing (bulls, contact,
    // risk area, vaccination programme etc).
    if ((version === 'v1-2' || isV13Plus(version)) && req.session.data.selectedCattle) {
      locals.farmDetails = getV12FarmDetailsForCph(req.session.data.selectedCattle)
    }
    res.render(`${version}/confirm-herd-or-animal`, locals)
  })

  router.post(`/${version}/confirm-herd-or-animal`, (req, res) => {
    const selected = req.body.selectedCattle

    if (!selected) {
      return res.render(`${version}/search-results`, {
        errors: {
          selectedCattle: { text: 'Select a farm' }
        },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [
            {
              text: 'Select a farm',
              href: '#selectedCattle'
            }
          ]
        }
      })
    }

    req.session.data.selectedCattle = selected
    req.session.data.herd = herdData[selected]
    req.session.data.selectedCattleLabel = herdData[selected] ? `${herdData[selected].cph} — ${herdData[selected].farm}` : selected
    return res.redirect(`/${version}/confirm-herd-or-animal`)
  })

  router.get(`/${version}/search-for-a-herd-or-animal-to-report`, (req, res) => {
    res.render(`${version}/search-for-a-herd-or-animal-to-report`)
  })

  router.post(`/${version}/search-for-a-herd-or-animal-to-report`, (req, res) => {
    handleReportSearch(req, res, `${version}/search-for-a-herd-or-animal-to-report`, version)
  })

  router.get(`/${version}/choose-a-herd-or-animal-to-report`, (req, res) => {
    res.render(`${version}/choose-a-herd-or-animal-to-report`)
  })

  router.get(`/${version}/confirm-herd-or-animal-to-report`, (req, res) => {
    res.render(`${version}/confirm-herd-or-animal-to-report`)
  })

  router.post(`/${version}/confirm-herd-or-animal-to-report`, (req, res) => {
    const selected = req.body.selectedCattle

    if (!selected) {
      return res.render(`${version}/choose-a-herd-or-animal-to-report`, {
        errors: {
          selectedCattle: { text: 'Select a herd or animal' }
        },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [
            {
              text: 'Select a herd or animal',
              href: '#selectedCattle'
            }
          ]
        }
      })
    }

    req.session.data.selectedCattle = selected
    req.session.data.herd = herdData[selected]
    req.session.data.selectedCattleLabel = herdData[selected] ? `${herdData[selected].cph} — ${herdData[selected].farm}` : selected
    return res.redirect(`/${version}/confirm-herd-or-animal-to-report`)
  })

  router.post(`/${version}/report-activity-type`, (req, res) => {
    const reportType = req.body.reportType
    req.session.data.reportType = reportType

    if (!reportType) {
      return res.render(`${version}/confirm-herd-or-animal-to-report`, {
        errors: {
          reportType: { text: 'Select what you want to report' }
        },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [
            {
              text: 'Select what you want to report',
              href: '#reportType'
            }
          ]
        }
      })
    }

    if (reportType === 'tb-test') {
      // Starting a new skin test report – reset per-report state
      req.session.data.skinTestEntries = null
      req.session.data.skinTestAddedEntries = null
      req.session.data.skinTestDay1Day = null
      req.session.data.skinTestDay1Month = null
      req.session.data.skinTestDay1Year = null
      req.session.data.skinTestDay2Day = null
      req.session.data.skinTestDay2Month = null
      req.session.data.skinTestDay2Year = null
      req.session.data.skinTestType = null
      req.session.data.currentSkinTestIndex = 0
      req.session.data.skinTestInProgress = true
      // The skin test report journey now starts with the same
      // "who did this work?" page used by the vaccination journey,
      // rendered in tester mode (heading: "Who tested the cattle?").
      return res.redirect(`/${version}/who-gave-the-vaccine`)
    }

    if (reportType === 'vaccination' || reportType === 'both') {
      return res.redirect(`/${version}/who-gave-the-vaccine`)
    }

    return res.redirect(`/${version}/report-summary`)
  })

  router.post(`/${version}/who-gave-the-vaccine`, (req, res) => {
    const administeredBy = req.body.administeredBy
    req.session.data.administeredBy = administeredBy
    req.session.data.firstName = req.body.firstName
    req.session.data.lastName = req.body.lastName
    req.session.data.theirRole = req.body.theirRole
    req.session.data.otherRole = req.body.otherRole

    // The same page is reused as the first step of the skin test
    // report journey. Tailor the error message and onward route to
    // whichever journey the vet is currently in.
    const isTbTest = req.session.data.reportType === 'tb-test'
    const errorText = isTbTest
      ? 'Select who tested the cattle'
      : 'Select who gave the vaccine'

    if (!administeredBy) {
      return res.render(`${version}/who-gave-the-vaccine`, {
        errors: {
          administeredBy: { text: errorText }
        },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: errorText, href: '#administeredBy' }]
        }
      })
    }

    if (isTbTest) {
      return res.redirect(`/${version}/skin-test-date`)
    }
    // Vaccination report: ask for the date the vaccination was given
    // before collecting batch / diluent details.
    return res.redirect(`/${version}/enter-vaccination-date`)
  })

  router.post(`/${version}/enter-vaccination-date`, (req, res) => {
    req.session.data.vaccinationDateDay = req.body['vaccinationDate-day']
    req.session.data.vaccinationDateMonth = req.body['vaccinationDate-month']
    req.session.data.vaccinationDateYear = req.body['vaccinationDate-year']
    return res.redirect(`/${version}/enter-vaccine-batch-details`)
  })

  router.post(`/${version}/enter-vaccine-batch-details`, (req, res) => {
    req.session.data.batchNumber = req.body.batchNumber
    req.session.data.batchExpiryDateDay = req.body['batchExpiryDate-day']
    req.session.data.batchExpiryDateMonth = req.body['batchExpiryDate-month']
    req.session.data.batchExpiryDateYear = req.body['batchExpiryDate-year']
    return res.redirect(`/${version}/enter-diluent-batch-details`)
  })

  router.get(`/${version}/enter-diluent-batch-details`, (req, res) => {
    res.render(`${version}/enter-diluent-batch-details`)
  })

  router.post(`/${version}/enter-diluent-batch-details`, (req, res) => {
    req.session.data.diluentBatchNumber = req.body.diluentBatchNumber
    req.session.data.diluentBatchExpiryDateDay = req.body['diluentBatchExpiryDate-day']
    req.session.data.diluentBatchExpiryDateMonth = req.body['diluentBatchExpiryDate-month']
    req.session.data.diluentBatchExpiryDateYear = req.body['diluentBatchExpiryDate-year']
    // New: ask the vet whether they want to mark the vaccinated cattle
    // first or the unvaccinated cattle first. Reset any previous choice
    // so a new journey always starts fresh.
    req.session.data.vaccinationApproach = null
    req.session.data.markingPhase = null
    req.session.data.activeReviewGroup = null
    // Clear report-scoped marking state so a new report starts from a
    // clean herd. Without this, cattle added on a previous report (and
    // the previous decisions / snapshots) leaked into the next one – e.g.
    // an added animal inflated Mill House's 38 cattle to 39 on the
    // check-your-answers page.
    req.session.data.vaccinationAddedAnimals = []
    req.session.data.cattleDecisions = {}
    req.session.data.otherReasons = {}
    req.session.data.vaccinatedCattle = []
    req.session.data.remainingCattleUpdates = []
    return res.redirect(`/${version}/vaccination-approach`)
  })

  // Approach chooser – the vet tells us whether they'll start by
  // marking the cattle that WERE vaccinated or the ones that were NOT.
  router.get(`/${version}/vaccination-approach`, (req, res) => {
    res.render(`${version}/vaccination-approach`)
  })

  router.post(`/${version}/vaccination-approach`, (req, res) => {
    const vaccinationApproach = req.body.vaccinationApproach
    req.session.data.vaccinationApproach = vaccinationApproach

    if (!vaccinationApproach) {
      return res.render(`${version}/vaccination-approach`, {
        errors: { vaccinationApproach: { text: 'Select which cattle you want to mark first' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select which cattle you want to mark first', href: '#vaccinationApproach' }]
        }
      })
    }

    // 'mark-vaccinated' starts on the vaccinated-selection phase (the
    // existing default). 'mark-not-vaccinated' skips straight to the
    // reasons phase so the vet can pick the exceptions and their
    // reasons in one go; remaining cattle are then bulk-confirmed as
    // vaccinated on the next screen.
    req.session.data.markingPhase = vaccinationApproach === 'mark-not-vaccinated'
      ? 'reasons'
      : 'vaccinated'
    req.session.data.activeReviewGroup = 'remaining'
    res.redirect(`/${version}/select-vaccinated-animals`)
  })

  // Confirmation between the first marking stage and handling the
  // remaining animals. Summarises what's been marked and, for the
  // "not-vaccinated-first" flow, tells the vet the remaining cattle
  // will be treated as vaccinated.
  function buildMarkingSummaryRows(req, version) {
    const animals = getReportingAnimals(req, version)
    const decisionMap = getDecisionMap(req.session.data)
    const groups = getReportingGroups(animals, decisionMap)
    const rows = []

    // The reason keys that all describe a NON-vaccinated animal. The
    // reason (including "no reason given") is a detail of the animal's
    // status, not a status in its own right.
    const reasonKeys = [
      { key: 'not-found', label: 'Not found' },
      { key: 'deceased', label: 'Deceased' },
      { key: 'withdrawn-export', label: 'Withdrawn for export' },
      { key: 'withdrawn-slaughter', label: 'Withdrawn for slaughter' },
      { key: 'withdrawn-owner', label: 'Withdrawn by owner' },
      { key: 'other', label: 'Other reason' },
      { key: 'no-reason', label: 'No reason given' }
    ]

    // v1-3: present two headline statuses - "Vaccinated" and "Not
    // vaccinated" - and hang the reason off the Not vaccinated row as a
    // sub-breakdown, rather than promoting each reason (e.g. "No reason
    // given") to a top-level status of its own.
    if (isV13Plus(version)) {
      if (groups.vaccinated.length > 0) {
        rows.push({
          key: { text: 'Vaccinated' },
          value: { text: String(groups.vaccinated.length) },
          actions: { items: [{ href: `/${version}/select-vaccinated-animals?group=vaccinated`, text: 'Change', visuallyHiddenText: 'the cattle marked as vaccinated' }] }
        })
      }

      const notVaccinatedCount = reasonKeys.reduce(function (sum, r) {
        return sum + (groups[r.key] || []).length
      }, 0)

      if (notVaccinatedCount > 0) {
        // Reason breakdown in the value column (no inline links), with a
        // "Change" action per reason in the right-hand actions column – so
        // the Change control sits in the same place as the Vaccinated row's.
        let html = '<p class="govuk-body govuk-!-margin-bottom-1">' +
          notVaccinatedCount + (notVaccinatedCount === 1 ? ' animal' : ' animals') + '</p>' +
          '<ul class="govuk-list govuk-!-font-size-16 govuk-!-margin-bottom-0">'
        const notVaxActions = []
        reasonKeys.forEach(function (r) {
          const c = (groups[r.key] || []).length
          if (c > 0) {
            html += '<li><span class="govuk-!-font-weight-bold">' + r.label + ':</span> ' + c + '</li>'
            notVaxActions.push({
              href: `/${version}/select-vaccinated-animals?group=${r.key}`,
              text: 'Change',
              visuallyHiddenText: 'the cattle marked as ' + r.label.toLowerCase()
            })
          }
        })
        html += '</ul>'
        rows.push({
          key: { text: 'Not vaccinated' },
          value: { html: html },
          actions: { items: notVaxActions }
        })
      }

      return rows
    }

    // Older versions keep the flat one-row-per-status summary.
    const statusLabels = {
      vaccinated: 'Vaccinated',
      'not-found': 'Not found',
      deceased: 'Deceased',
      'withdrawn-export': 'Withdrawn for export',
      'withdrawn-slaughter': 'Withdrawn for slaughter',
      'withdrawn-owner': 'Withdrawn by owner',
      other: 'Other reason',
      'no-reason': 'No reason given'
    }

    Object.keys(statusLabels).forEach(function (key) {
      const count = (groups[key] || []).length
      if (count > 0) {
        rows.push({
          key: { text: statusLabels[key] },
          value: { text: String(count) },
          actions: {
            items: [
              {
                href: `/${version}/select-vaccinated-animals?group=${key}`,
                text: 'Change',
                visuallyHiddenText: 'the cattle marked as ' + statusLabels[key].toLowerCase()
              }
            ]
          }
        })
      }
    })

    return rows
  }

  router.get(`/${version}/vaccination-marked-confirm`, (req, res) => {
    const animals = getReportingAnimals(req, version)
    const decisionMap = getDecisionMap(req.session.data)
    const groups = getReportingGroups(animals, decisionMap)
    const totalAnimals = animals.length
    const countRemaining = groups.remaining.length
    const countMarked = totalAnimals - countRemaining

    res.render(`${version}/vaccination-marked-confirm`, {
      vaccinationApproach: req.session.data.vaccinationApproach || 'mark-vaccinated',
      totalAnimals,
      countMarked,
      countRemaining,
      summaryRows: buildMarkingSummaryRows(req, version)
    })
  })

  router.post(`/${version}/vaccination-marked-confirm`, (req, res) => {
    const confirmAction = req.body.confirmAction
    const approach = req.session.data.vaccinationApproach || 'mark-vaccinated'

    if (confirmAction === 'back') {
      // When every animal is already accounted for, sending the vet
      // to the default "remaining" view would just bounce them back
      // here (the GET handler redirects away from the empty
      // remaining group). Pick the first banked group with cattle in
      // it so the vet lands somewhere they can actually edit from.
      const animals = getReportingAnimals(req, version)
      const decisionMap = getDecisionMap(req.session.data)
      const groups = getReportingGroups(animals, decisionMap)
      if (groups.remaining.length === 0) {
        const bankedKeys = [
          'vaccinated', 'not-found', 'deceased',
          'withdrawn-export', 'withdrawn-slaughter', 'withdrawn-owner', 'other',
          'no-reason'
        ]
        const firstBanked = bankedKeys.find(function (k) {
          return (groups[k] || []).length > 0
        })
        if (firstBanked) {
          return res.redirect(`/${version}/select-vaccinated-animals?group=${firstBanked}`)
        }
      }
      return res.redirect(`/${version}/select-vaccinated-animals`)
    }

    const animals = getReportingAnimals(req, version)
    const decisionMap = getDecisionMap(req.session.data)
    const groups = getReportingGroups(animals, decisionMap)

    // No remaining cattle: go straight to the check-your-answers step.
    if (groups.remaining.length === 0) {
      req.session.data.vaccinatedCattle = groups.vaccinated.map(a => a.officialId)
      const otherReasons = req.session.data.otherReasons || {}
      req.session.data.remainingCattleUpdates = [
        { status: 'not-found', cattle: groups['not-found'].map(a => a.officialId) },
        { status: 'deceased', cattle: groups.deceased.map(a => a.officialId) },
        { status: 'withdrawn-export', cattle: groups['withdrawn-export'].map(a => a.officialId) },
        { status: 'withdrawn-slaughter', cattle: groups['withdrawn-slaughter'].map(a => a.officialId) },
        { status: 'withdrawn-owner', cattle: groups['withdrawn-owner'].map(a => a.officialId) },
        {
          status: 'other',
          cattle: groups.other.map(a => a.officialId),
          reasons: groups.other.reduce((acc, a) => {
            if (otherReasons[a.officialId]) acc[a.officialId] = otherReasons[a.officialId]
            return acc
          }, {})
        },
        { status: 'no-reason', cattle: (groups['no-reason'] || []).map(a => a.officialId) }
      ].filter(g => g.cattle.length)
      // v1-3: before the check-your-answers step, give the vet a chance
      // to add cattle that weren't on the original list (mirrors the
      // "Are there more cattle to add?" gate on the skin-test journey).
      if (isV13Plus(version)) {
        return res.redirect(`/${version}/vaccination-add-cattle-question`)
      }
      return res.redirect(`/${version}/check-report-answers`)
    }

    // Advance to the second marking stage. For the "mark-vaccinated"
    // approach we move to 'reasons'. For the "mark-not-vaccinated"
    // approach we move to 'vaccinated' so the vet can confirm the
    // remaining cattle are really vaccinated.
    req.session.data.markingPhase = approach === 'mark-not-vaccinated' ? 'vaccinated' : 'reasons'
    req.session.data.activeReviewGroup = 'remaining'
    // v1-3: when the vet is about to start the reasons phase, fork
    // through /give-unvaccinated-reasons first so they can choose to
    // bulk-mark every unvaccinated animal as "no reason given"
    // instead of stepping through the reasons table animal by
    // animal. Earlier versions go straight into the table as before.
    if (isV13Plus(version) && req.session.data.markingPhase === 'reasons') {
      return res.redirect(`/${version}/give-unvaccinated-reasons`)
    }
    res.redirect(`/${version}/select-vaccinated-animals`)
  })

  // v1-3 only: "Would you like to give a reason for the XX cattle
  // not vaccinated?" prompt. Sits between /vaccination-marked-confirm
  // and the reasons phase of /select-vaccinated-animals so the vet
  // can opt out of per-animal reasons in one go.
  router.get(`/${version}/give-unvaccinated-reasons`, (req, res) => {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/select-vaccinated-animals`)
    }
    const animals = getReportingAnimals(req, version)
    const decisionMap = getDecisionMap(req.session.data)
    const groups = getReportingGroups(animals, decisionMap)
    const unvaccinatedCount = groups.remaining.length
    // No remaining animals to give a reason for – nothing to ask.
    // Bounce back to the confirmation page rather than render an
    // empty question.
    if (unvaccinatedCount === 0) {
      return res.redirect(`/${version}/vaccination-marked-confirm`)
    }
    res.render(`${version}/give-unvaccinated-reasons`, {
      unvaccinatedCount
    })
  })

  router.post(`/${version}/give-unvaccinated-reasons`, (req, res) => {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/select-vaccinated-animals`)
    }
    const choice = req.body.giveUnvaccinatedReasons
    const animals = getReportingAnimals(req, version)
    const decisionMap = getDecisionMap(req.session.data)
    const groups = getReportingGroups(animals, decisionMap)
    const unvaccinatedCount = groups.remaining.length

    if (choice !== 'yes' && choice !== 'no') {
      return res.render(`${version}/give-unvaccinated-reasons`, {
        unvaccinatedCount,
        errors: { giveUnvaccinatedReasons: { text: 'Select whether you want to give a reason for the cattle not vaccinated' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select whether you want to give a reason for the cattle not vaccinated', href: '#giveUnvaccinatedReasons' }]
        }
      })
    }

    if (choice === 'yes') {
      // Vet wants to give per-animal reasons – on to the reasons
      // table where they pick each animal's specific status.
      req.session.data.markingPhase = 'reasons'
      req.session.data.activeReviewGroup = 'remaining'
      return res.redirect(`/${version}/select-vaccinated-animals`)
    }

    // No: bulk-mark every remaining animal as "no reason given" and
    // continue through the confirmation page. Mirrors the existing
    // "Skip and mark as no reason given" shortcut on the reasons-
    // phase view of /select-vaccinated-animals.
    const newDecisionMap = { ...decisionMap }
    const currentOtherReasons = { ...(req.session.data.otherReasons || {}) }
    animals.forEach(function (animal) {
      const id = animal.officialId
      if (!newDecisionMap[id] || newDecisionMap[id] === 'remaining') {
        newDecisionMap[id] = 'no-reason'
        delete currentOtherReasons[id]
      }
    })
    req.session.data.cattleDecisions = newDecisionMap
    req.session.data.otherReasons = currentOtherReasons
    res.redirect(`/${version}/vaccination-marked-confirm`)
  })

  // ---------------------------------------------------------------------
  // v1-3 only: "Are there more cattle to add?" gate + add-cattle form.
  // Mirrors the skin-test journey's add-cattle pattern: between the
  // marking confirmation and the check-your-answers step the vet can
  // record animals that weren't on the original list (e.g. a newly
  // arrived animal). Added animals are merged into the reporting herd
  // (see getVaccinationAddedAnimals) and default to "vaccinated" so the
  // report stays complete; the vet can change that via the normal
  // "Change" links like any other animal.
  // ---------------------------------------------------------------------

  // Rebuild the report summary data (vaccinatedCattle +
  // remainingCattleUpdates) from the current decisions. Called when the
  // vet leaves the add-cattle gate so any animals added (or removed)
  // since the confirmation page are reflected on check-your-answers.
  function buildVaccinationReportData(req, version) {
    const animals = getReportingAnimals(req, version)
    const decisionMap = getDecisionMap(req.session.data)
    const groups = getReportingGroups(animals, decisionMap)
    const otherReasons = req.session.data.otherReasons || {}
    req.session.data.vaccinatedCattle = groups.vaccinated.map(a => a.officialId)
    req.session.data.remainingCattleUpdates = [
      { status: 'not-found', cattle: groups['not-found'].map(a => a.officialId) },
      { status: 'deceased', cattle: groups.deceased.map(a => a.officialId) },
      { status: 'withdrawn-export', cattle: groups['withdrawn-export'].map(a => a.officialId) },
      { status: 'withdrawn-slaughter', cattle: groups['withdrawn-slaughter'].map(a => a.officialId) },
      { status: 'withdrawn-owner', cattle: groups['withdrawn-owner'].map(a => a.officialId) },
      {
        status: 'other',
        cattle: groups.other.map(a => a.officialId),
        reasons: groups.other.reduce((acc, a) => {
          if (otherReasons[a.officialId]) acc[a.officialId] = otherReasons[a.officialId]
          return acc
        }, {})
      },
      { status: 'no-reason', cattle: (groups['no-reason'] || []).map(a => a.officialId) }
    ].filter(g => g.cattle.length)
  }

  router.get(`/${version}/vaccination-add-cattle-question`, (req, res) => {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/check-report-answers`)
    }
    res.render(`${version}/vaccination-add-cattle-question`, {
      addedAnimals: getVaccinationAddedAnimals(req, version)
    })
  })

  router.post(`/${version}/vaccination-add-cattle-question`, (req, res) => {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/check-report-answers`)
    }
    const addMoreCattle = req.body.addMoreCattle
    req.session.data.addMoreCattle = addMoreCattle

    if (addMoreCattle !== 'yes' && addMoreCattle !== 'no') {
      return res.render(`${version}/vaccination-add-cattle-question`, {
        addedAnimals: getVaccinationAddedAnimals(req, version),
        errors: { addMoreCattle: { text: 'Select yes if there are more cattle to add, or no to continue' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select yes if there are more cattle to add, or no to continue', href: '#addMoreCattle' }]
        }
      })
    }

    if (addMoreCattle === 'yes') {
      return res.redirect(`/${version}/vaccination-add-another`)
    }

    // No more cattle to add – rebuild the summary data (in case the vet
    // added or removed animals) and continue to check your answers.
    buildVaccinationReportData(req, version)
    res.redirect(`/${version}/check-report-answers`)
  })

  router.get(`/${version}/vaccination-add-another`, (req, res) => {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/check-report-answers`)
    }
    res.render(`${version}/vaccination-add-another`, { formValues: {}, breedItems: buildBreedItems('') })
  })

  router.post(`/${version}/vaccination-add-another`, (req, res) => {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/check-report-answers`)
    }
    const earTag = (req.body.earTag || '').trim()
    const breed = (req.body.breed || '').trim()
    const sex = (req.body.addedSex || '').trim()
    const dobDay = (req.body['addedDob-day'] || '').trim()
    const dobMonth = (req.body['addedDob-month'] || '').trim()
    const dobYear = (req.body['addedDob-year'] || '').trim()
    const dob = (dobDay && dobMonth && dobYear) ? `${dobDay}/${dobMonth}/${dobYear}` : ''

    const formValues = {
      earTag,
      breed,
      addedSex: sex,
      addedDobDay: dobDay,
      addedDobMonth: dobMonth,
      addedDobYear: dobYear,
      remarks: (req.body.remarks || '').trim()
    }

    if (!earTag) {
      return res.render(`${version}/vaccination-add-another`, {
        formValues,
        breedItems: buildBreedItems(breed),
        errors: { earTag: { text: 'Enter the ear tag number' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Enter the ear tag number', href: '#earTag' }]
        }
      })
    }

    const added = Array.isArray(req.session.data.vaccinationAddedAnimals)
      ? [...req.session.data.vaccinationAddedAnimals]
      : []

    // Shape the added animal to match the seeded reporting herd so it
    // sorts, renders and groups like any other animal.
    added.push({
      officialId: earTag,
      earTagNumber: earTag,
      barcode: earTag,
      breed,
      dob,
      sex,
      vaccinationStatus: 'Vaccinated',
      notes: formValues.remarks,
      addedManually: true
    })
    req.session.data.vaccinationAddedAnimals = added

    // Default the added animal to "vaccinated" so the report is
    // complete. The vet can change this via the confirmation / check
    // answers "Change" links.
    const decisionMap = { ...getDecisionMap(req.session.data) }
    decisionMap[earTag] = 'vaccinated'
    req.session.data.cattleDecisions = decisionMap

    // Back to the gate so the vet can add another or continue.
    res.redirect(`/${version}/vaccination-add-cattle-question`)
  })

  // Edit (or remove) an animal previously added on
  // /vaccination-add-another, reached from the "Change" link on the
  // gate page. Reuses the add-another form in edit mode.
  router.get(`/${version}/vaccination-add-another/edit/:earTag`, (req, res) => {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/check-report-answers`)
    }
    const earTag = req.params.earTag
    const added = getVaccinationAddedAnimals(req, version)
    const entry = added.find(a => a.officialId === earTag)
    if (!entry) {
      return res.redirect(`/${version}/vaccination-add-cattle-question`)
    }
    const dobParts = (entry.dob || '').split('/')
    res.render(`${version}/vaccination-add-another`, {
      isEditMode: true,
      originalEarTag: earTag,
      breedItems: buildBreedItems(entry.breed || ''),
      formValues: {
        earTag: entry.officialId,
        breed: entry.breed || '',
        addedSex: entry.sex || '',
        addedDobDay: dobParts[0] || '',
        addedDobMonth: dobParts[1] || '',
        addedDobYear: dobParts[2] || '',
        remarks: entry.notes || ''
      }
    })
  })

  router.post(`/${version}/vaccination-add-another/edit/:earTag`, (req, res) => {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/check-report-answers`)
    }
    const originalEarTag = req.params.earTag
    const added = Array.isArray(req.session.data.vaccinationAddedAnimals)
      ? [...req.session.data.vaccinationAddedAnimals]
      : []
    const idx = added.findIndex(a => a.officialId === originalEarTag)

    // Remove button – drop the animal and its decision, then return.
    if (req.body.addedAction === 'remove') {
      if (idx >= 0) {
        added.splice(idx, 1)
        req.session.data.vaccinationAddedAnimals = added
      }
      const decisionMap = { ...getDecisionMap(req.session.data) }
      delete decisionMap[originalEarTag]
      req.session.data.cattleDecisions = decisionMap
      return res.redirect(`/${version}/vaccination-add-cattle-question`)
    }

    const earTag = (req.body.earTag || '').trim()
    const breed = (req.body.breed || '').trim()
    const sex = (req.body.addedSex || '').trim()
    const dobDay = (req.body['addedDob-day'] || '').trim()
    const dobMonth = (req.body['addedDob-month'] || '').trim()
    const dobYear = (req.body['addedDob-year'] || '').trim()
    const dob = (dobDay && dobMonth && dobYear) ? `${dobDay}/${dobMonth}/${dobYear}` : ''
    const remarks = (req.body.remarks || '').trim()

    const formValues = {
      earTag,
      breed,
      addedSex: sex,
      addedDobDay: dobDay,
      addedDobMonth: dobMonth,
      addedDobYear: dobYear,
      remarks
    }

    if (!earTag) {
      return res.render(`${version}/vaccination-add-another`, {
        isEditMode: true,
        originalEarTag,
        formValues,
        breedItems: buildBreedItems(breed),
        errors: { earTag: { text: 'Enter the ear tag number' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Enter the ear tag number', href: '#earTag' }]
        }
      })
    }

    if (idx >= 0) {
      added[idx] = Object.assign({}, added[idx], {
        officialId: earTag,
        earTagNumber: earTag,
        barcode: earTag,
        breed,
        dob,
        sex,
        notes: remarks
      })
      req.session.data.vaccinationAddedAnimals = added

      // Carry the decision over if the ear tag changed.
      if (earTag !== originalEarTag) {
        const decisionMap = { ...getDecisionMap(req.session.data) }
        decisionMap[earTag] = decisionMap[originalEarTag] || 'vaccinated'
        delete decisionMap[originalEarTag]
        req.session.data.cattleDecisions = decisionMap
      }
    }
    res.redirect(`/${version}/vaccination-add-cattle-question`)
  })

  router.get(`/${version}/select-vaccinated-animals`, (req, res) => {
    req.session.data.markingPhase = req.session.data.markingPhase || 'vaccinated'
    // Allow the confirmation page's per-row "Change" links to deep
    // link straight into the right group via ?group=<key>. We
    // validate the value against the known group keys so a malformed
    // query param falls back to the default "remaining" view.
    const allowedGroups = [
      'remaining', 'vaccinated', 'not-found', 'deceased',
      'withdrawn-export', 'withdrawn-slaughter', 'withdrawn-owner', 'other',
      'no-reason'
    ]
    const groupParam = req.query && req.query.group
    if (groupParam && allowedGroups.indexOf(groupParam) !== -1) {
      req.session.data.activeReviewGroup = groupParam
    } else {
      req.session.data.activeReviewGroup = req.session.data.activeReviewGroup || 'remaining'
    }

    // v1-2: once every animal has been marked there's nothing to do
    // on the "remaining" view, so redirect the vet straight to the
    // confirmation page. Banked groups (vaccinated, not-found, etc.)
    // stay accessible because that's how the vet edits an existing
    // decision – either via the per-row "Change" links from the
    // confirmation page, or by switching group from the side panel.
    if ((version === 'v1-2' || isV13Plus(version)) && req.session.data.activeReviewGroup === 'remaining') {
      const animals = getReportingAnimals(req, version)
      const decisionMap = getDecisionMap(req.session.data)
      const groups = getReportingGroups(animals, decisionMap)
      if (animals.length > 0 && groups.remaining.length === 0) {
        return res.redirect(`/${version}/vaccination-marked-confirm`)
      }
    }
    return renderSelectVaccinatedAnimals(req, res, version)
  })

  router.post(`/${version}/select-vaccinated-animals`, (req, res) => {
    const animals = getReportingAnimals(req, version)
    const lookup = getAnimalLookup(animals)
    const selectedIds = Array.isArray(req.body.selectedAnimals)
      ? req.body.selectedAnimals
      : (req.body.selectedAnimals ? [req.body.selectedAnimals] : [])
    const markAction = req.body.markAction
    const selectedStatus = req.body.selectedStatus
    const otherReason = (req.body.otherReason || '').trim()

    req.session.data.markingPhase = req.session.data.markingPhase || 'vaccinated'
    req.session.data.activeReviewGroup = req.session.data.activeReviewGroup || 'remaining'

    if (markAction === 'view-group') {
      req.session.data.activeReviewGroup = req.body.reviewGroup || 'remaining'
      return res.redirect(`/${version}/select-vaccinated-animals`)
    }

    if (markAction === 'continue-to-reasons') {
      // Route through the confirmation page. The confirmation POST
      // then bumps us to the 'reasons' phase (or 'vaccinated' for
      // the inverse approach) and back to this screen.
      return res.redirect(`/${version}/vaccination-marked-confirm`)
    }

    // Reasons-phase shortcut: the vet doesn't want to record a
    // specific reason for the remaining cattle. Bulk-mark every
    // remaining animal as "no reason given" and continue through the
    // confirmation page. Triggered by the "Skip and mark as no
    // reason given" link at the bottom of the reasons-phase view.
    if (markAction === 'skip-no-reason') {
      const decisionMap = { ...getDecisionMap(req.session.data) }
      const currentOtherReasons = { ...(req.session.data.otherReasons || {}) }
      animals.forEach(function (animal) {
        const id = animal.officialId
        if (!decisionMap[id] || decisionMap[id] === 'remaining') {
          decisionMap[id] = 'no-reason'
          delete currentOtherReasons[id]
        }
      })
      req.session.data.cattleDecisions = decisionMap
      req.session.data.otherReasons = currentOtherReasons
      return res.redirect(`/${version}/vaccination-marked-confirm`)
    }

    // Inverse flow shortcut: the vet has finished marking the cattle
    // that were NOT vaccinated. Bulk-mark every remaining animal as
    // vaccinated and go to the confirmation page.
    if (markAction === 'bulk-vaccinate-remaining') {
      const decisionMap = { ...getDecisionMap(req.session.data) }
      const currentOtherReasons = { ...(req.session.data.otherReasons || {}) }
      animals.forEach(function (animal) {
        const id = animal.officialId
        if (!decisionMap[id] || decisionMap[id] === 'remaining') {
          decisionMap[id] = 'vaccinated'
          // Remove any stale "other" reason from a previous selection
          delete currentOtherReasons[id]
        }
      })
      req.session.data.cattleDecisions = decisionMap
      req.session.data.otherReasons = currentOtherReasons
      return res.redirect(`/${version}/vaccination-marked-confirm`)
    }

    if (markAction === 'continue') {
      const decisionMap = getDecisionMap(req.session.data)
      const groups = getReportingGroups(animals, decisionMap)

      // Validation removed – the vet can continue even when some
      // cattle still have no decision. Anything in groups.remaining
      // is rolled forward unchanged.

      req.session.data.vaccinatedCattle = groups.vaccinated.map(animal => animal.officialId)
      const otherReasons = req.session.data.otherReasons || {}
      req.session.data.remainingCattleUpdates = [
        { status: 'not-found', cattle: groups['not-found'].map(animal => animal.officialId) },
        { status: 'deceased', cattle: groups.deceased.map(animal => animal.officialId) },
        { status: 'withdrawn-export', cattle: groups['withdrawn-export'].map(animal => animal.officialId) },
        { status: 'withdrawn-slaughter', cattle: groups['withdrawn-slaughter'].map(animal => animal.officialId) },
        { status: 'withdrawn-owner', cattle: groups['withdrawn-owner'].map(animal => animal.officialId) },
        {
          status: 'other',
          cattle: groups.other.map(animal => animal.officialId),
          reasons: groups.other.reduce((acc, animal) => {
            if (otherReasons[animal.officialId]) {
              acc[animal.officialId] = otherReasons[animal.officialId]
            }
            return acc
          }, {})
        },
        { status: 'no-reason', cattle: (groups['no-reason'] || []).map(animal => animal.officialId) }
      ].filter(group => group.cattle.length)

      // v1-3: offer the add-cattle step before check-your-answers,
      // matching the gate reached from the confirmation page.
      if (isV13Plus(version)) {
        return res.redirect(`/${version}/vaccination-add-cattle-question`)
      }
      return res.redirect(`/${version}/check-report-answers`)
    }

    if (markAction === 'reset') {
      const decisionMap = { ...getDecisionMap(req.session.data) }
      const otherReasons = { ...(req.session.data.otherReasons || {}) }
      selectedIds.forEach(id => {
        delete decisionMap[id]
        delete otherReasons[id]
      })
      req.session.data.cattleDecisions = decisionMap
      req.session.data.otherReasons = otherReasons
      req.session.data.activeReviewGroup = 'remaining'
      return res.redirect(`/${version}/select-vaccinated-animals`)
    }

    // Validation removed – an empty selection just falls through:
    // the per-id loop below becomes a no-op and the redirect rules
    // decide where the vet lands next.

    if (markAction !== 'mark') {
      return res.redirect(`/${version}/select-vaccinated-animals`)
    }

    // When the vet is editing a banked reason group via a "Change"
    // link from the confirmation page, the picked status comes from
    // the reason radios – even if the journey's overall markingPhase
    // is still 'vaccinated'. Only treat finalStatus as
    // 'vaccinated' when the vet is actually on the remaining-view
    // during the vaccinated phase.
    const reasonGroupKeys = [
      'not-found', 'deceased',
      'withdrawn-export', 'withdrawn-slaughter', 'withdrawn-owner', 'other'
    ]
    const isReasonView = reasonGroupKeys.indexOf(req.session.data.activeReviewGroup) !== -1
    // Editing a banked group (vaccinated, a reason, or no-reason) reached via
    // a "Change" link. The whole herd is shown with the group's members
    // pre-selected, and the group being edited is submitted as a hidden
    // field, so the picked status comes straight from that.
    const groupEditKeys = [
      'vaccinated', 'not-found', 'deceased', 'withdrawn-export',
      'withdrawn-slaughter', 'withdrawn-owner', 'other', 'no-reason'
    ]
    const isGroupEdit = groupEditKeys.indexOf(req.session.data.activeReviewGroup) !== -1
    const finalStatus = isGroupEdit
      ? selectedStatus
      : ((req.session.data.markingPhase === 'vaccinated' && !isReasonView)
          ? 'vaccinated'
          : selectedStatus)

    // Validation removed – the vet can mark cattle in the reasons
    // phase without picking a status, and the "Other" reason can be
    // left blank. Downstream code stores whatever's there.

    const decisionMap = { ...getDecisionMap(req.session.data) }
    const otherReasons = { ...(req.session.data.otherReasons || {}) }

    selectedIds.forEach(id => {
      if (lookup[id]) {
        decisionMap[id] = finalStatus

        if (finalStatus === 'other') {
          otherReasons[id] = otherReason
        } else {
          delete otherReasons[id]
        }
      }
    })

    // Editing a banked group from a "Change" link shows the whole herd with
    // the group's members pre-selected, so a submit is the complete new
    // membership. Any animal that was in this group but is no longer
    // selected has been removed from it – default it to the opposite state:
    // removing from "vaccinated" sends it back to remaining (so it can be
    // given a reason); removing from a not-vaccinated group marks it
    // vaccinated.
    if (isGroupEdit) {
      const editingGroup = req.session.data.activeReviewGroup
      const removedDefault = editingGroup === 'vaccinated' ? 'remaining' : 'vaccinated'
      const selectedSet = new Set(selectedIds)
      animals.forEach(function (animal) {
        const id = animal.officialId
        if (decisionMap[id] === editingGroup && !selectedSet.has(id)) {
          if (removedDefault === 'remaining') {
            delete decisionMap[id]
          } else {
            decisionMap[id] = removedDefault
          }
          delete otherReasons[id]
        }
      })
    }

    req.session.data.cattleDecisions = decisionMap
    req.session.data.otherReasons = otherReasons
    // Editing a banked group from a "Change" link – keep the vet on that
    // group view (don't snap back to "remaining" like we do during initial
    // marking) so they can finish editing before going back to confirmation.
    if (!isGroupEdit) {
      req.session.data.activeReviewGroup = 'remaining'
    }

    // v1-2 redirect rules after a mark:
    //   1. "Vaccinated" phase on the remaining view – go to the
    //      confirmation page so the vet can review and then continue
    //      on to add reasons for the cattle that weren't vaccinated.
    //   2. Editing a banked reason group via a "Change" link – the
    //      vet has changed an animal from one reason to another, so
    //      send them straight back to the confirmation page where
    //      the new counts are visible.
    //   3. "Reasons" phase on the remaining view – stay on the
    //      select page so the vet can mark another batch with a
    //      different reason, UNLESS every animal has now been
    //      accounted for, in which case skip straight to the
    //      confirmation page.
    // "Record the cattle that were not vaccinated" approach: one action.
    // The vet has selected the unvaccinated cattle and given a reason, so
    // mark every other still-remaining animal as vaccinated and go straight
    // to the check page. (Editing a banked group via a Change link is
    // excluded – that only changes the one group.)
    const isMarkNotVaxApproach = req.session.data.vaccinationApproach === 'mark-not-vaccinated'
    if ((version === 'v1-2' || isV13Plus(version)) && isMarkNotVaxApproach && !isGroupEdit) {
      const otherReasonsAfter = { ...(req.session.data.otherReasons || {}) }
      animals.forEach(function (animal) {
        const id = animal.officialId
        if (!decisionMap[id] || decisionMap[id] === 'remaining') {
          decisionMap[id] = 'vaccinated'
          delete otherReasonsAfter[id]
        }
      })
      req.session.data.cattleDecisions = decisionMap
      req.session.data.otherReasons = otherReasonsAfter
      return res.redirect(`/${version}/vaccination-marked-confirm`)
    }

    if ((version === 'v1-2' || isV13Plus(version))) {
      const groupsAfterMark = getReportingGroups(animals, decisionMap)
      const noneRemaining = groupsAfterMark.remaining.length === 0
      const vaccinatedOnRemaining = req.session.data.markingPhase === 'vaccinated'
        && !isGroupEdit
      if (vaccinatedOnRemaining || isGroupEdit || noneRemaining) {
        return res.redirect(`/${version}/vaccination-marked-confirm`)
      }
    }
    return res.redirect(`/${version}/select-vaccinated-animals`)
  })

  router.post(`/${version}/add-a-note`, (req, res) => {
    req.session.data.vaccinationNote = req.body.vaccinationNote
    return res.redirect(`/${version}/check-report-answers`)
  })

  // v1-2: /check-report-answers now carries a yes/no declaration that
  // the vet has checked their answers. The page is template-served by
  // the prototype kit; this GET handler exists only so an error from
  // a failed submission can be lifted out of session and rendered as
  // the standard govukErrorSummary + per-field error message.
  if ((version === 'v1-2' || isV13Plus(version))) {
    router.get(`/${version}/check-report-answers`, function (req, res) {
      const errorState = req.session.data.checkAnswersError
      // One-shot: clear the flag so refreshing the page after a
      // successful correction doesn't keep showing the error.
      req.session.data.checkAnswersError = null
      const errors = errorState
        ? { answersChecked: { text: 'Select yes to confirm you have checked the answers' } }
        : null
      const errorSummary = errorState
        ? {
            titleText: 'There is a problem',
            errorList: [{
              text: 'Select yes to confirm you have checked the answers',
              href: '#answersChecked'
            }]
          }
        : null
      res.render(`${version}/check-report-answers`, { errors, errorSummary })
    })
  }

  router.post(`/${version}/submit-vaccination-report`, (req, res) => {
    // v1-2: validate the declaration before we let the vet submit.
    // Older versions don't have the declaration and submit through
    // unchanged.
    if ((version === 'v1-2' || isV13Plus(version))) {
      const answersChecked = req.body.answersChecked
      req.session.data.answersChecked = answersChecked
      if (answersChecked !== 'yes') {
        req.session.data.checkAnswersError = true
        return res.redirect(`/${version}/check-report-answers`)
      }
      req.session.data.checkAnswersError = null
    }
    // v1-3: a filed vaccination report leaves "Work in progress" and moves
    // to the dashboard's "Recently completed" section. Drop the prepared
    // vaccination record for this farm so it no longer shows as to-do.
    if (isV13Plus(version)) {
      const herd = req.session.data.herd
      if (herd && herd.cph) {
        recordCompletedReport(req, {
          cph: herd.cph,
          farm: herd.farm,
          type: 'vaccination',
          typeLabel: 'BCG vaccination report',
          // Snapshot the report content so the vet can reopen it from the
          // farm-tasks "Completed" list and amend what they filed.
          snapshot: snapshotVaccinationReport(req)
        })
        if (Array.isArray(req.session.data.vaccinationListPrepared)) {
          req.session.data.vaccinationListPrepared = req.session.data.vaccinationListPrepared
            .filter(function (r) { return r && r.cph !== herd.cph })
        }
      }
    }
    return res.redirect(`/${version}/report-submitted`)
  })

  // One Login
  router.get(`/${version}/one-login`, function (req, res) {
    res.render(`${version}/one-login`)
  })

  router.get(`/${version}/one-login-email`, function (req, res) {
    res.render(`${version}/one-login-email`, { error: null })
  })

  router.post(`/${version}/one-login-email`, function (req, res) {
    const email = (req.body.email || '').trim()
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

    req.session.data.email = email

    if (!email) {
      return res.render(`${version}/one-login-email`, {
        error: 'Enter your email address'
      })
    }

    if (!emailPattern.test(email)) {
      return res.render(`${version}/one-login-email`, {
        error: 'Enter an email address in the correct format, like name@example.com'
      })
    }

    res.redirect(`/${version}/one-login-password`)
  })

  router.get(`/${version}/one-login-password`, function (req, res) {
    res.render(`${version}/one-login-password`)
  })

  router.post(`/${version}/one-login-password`, function (req, res) {
    const password = (req.body.password || '').trim()

    req.session.data.password = password

    if (!password) {
      return res.render(`${version}/one-login-password`, {
        error: 'Enter your password'
      })
    }

    req.session.data.userName = 'Alex Taylor'
    res.redirect(`/${version}/dashboard`)
  })

  // ---------------------------------------------------------------------------
  // Download list routes
  // ---------------------------------------------------------------------------
  router.get(`/${version}/check-list-details`, function (req, res) {
    res.render(`${version}/check-list-details`)
  })

  router.post(`/${version}/check-list-details`, function (req, res) {
    let fields = req.body.fields || []

    if (!Array.isArray(fields)) {
      fields = [fields]
    }

    req.session.data.fields = fields.filter(field => field && field !== '_unchecked')
    req.session.data.sortBy = req.body.sortBy || 'Ear-tag number'
    req.session.data.sortDirection = req.body.sortDirection || 'asc'

    // Record the prepared vaccination list against the current farm
    // so the dashboard's "Work in progress" can offer the vet a way
    // back to view / edit / reprint, or to report vaccinations for
    // the same cattle. We only mark this for the vaccinate-list
    // journey (the same template is reused by the skin-test list
    // path which has its own completion record).
    const herd = req.session.data.herd
    const cph = herd && herd.cph
    if (cph && req.session.data.listType === 'Vaccinate cattle') {
      const existing = Array.isArray(req.session.data.vaccinationListPrepared)
        ? req.session.data.vaccinationListPrepared.filter(function (r) { return r && r.cph !== cph })
        : []
      existing.push({ cph, preparedAt: new Date().toISOString() })
      req.session.data.vaccinationListPrepared = existing
    }

    res.redirect(`/${version}/download-list`)
  })

  router.get(`/${version}/prepare-list-download`, function (req, res) {
    res.render(`${version}/prepare-list-download`)
  })

  router.post(`/${version}/prepare-list-download`, function (req, res) {
    const downloadFormat = req.body.downloadFormat

    req.session.data.listType = req.session.data.listType || 'Vaccinate cattle'

    if (!downloadFormat) {
      return res.render(`${version}/prepare-list-download`, {
        errors: {
          downloadFormat: { text: 'Select how you want to download the list' }
        },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [
            {
              text: 'Select how you want to download the list',
              href: '#downloadFormat'
            }
          ]
        }
      })
    }

    req.session.data.downloadFormat = downloadFormat

    if (!normaliseFields(req.session.data.fields).length) {
      req.session.data.fields = availableListColumns
    }

    req.session.data.sortBy = req.session.data.sortBy || 'Ear-tag number'
    req.session.data.sortDirection = req.session.data.sortDirection || 'asc'
    req.session.data.previewOptions = req.session.data.previewOptions || ['show-last-five', ...availableListColumns]

    res.redirect(`/${version}/check-list-details`)
  })

  router.post(`/${version}/download-list/setup`, function (req, res) {
    req.session.data.listType = req.body.listType || req.session.data.listType || 'Vaccinate cattle'

    if (!normaliseFields(req.session.data.fields).length) {
      req.session.data.fields = availableListColumns
    }

    req.session.data.downloadFormat = req.session.data.downloadFormat || 'pdf'
    req.session.data.sortBy = req.session.data.sortBy || 'Ear-tag number'
    req.session.data.sortDirection = req.session.data.sortDirection || 'asc'
    req.session.data.previewOptions = req.session.data.previewOptions || ['show-last-five', ...availableListColumns]

    // Branch into the skin-test prepare-list flow when the vet has said
    // they'll give a skin test on this visit
    if (req.session.data.listType === 'Give skin test') {
      return res.redirect(`/${version}/skin-test-list`)
    }

    res.redirect(`/${version}/download-list`)
  })

  router.post(`/${version}/download-list`, function (req, res) {
    // v1-2 vaccination list mirrors the v1-2 skin-test-list settings:
    // a "look" radio (easy / compact) that drives page size and visual
    // density, and a sort key. Everything else is fixed for v1-2.
    if ((version === 'v1-2' || isV13Plus(version))) {
      const listLook = req.body.listLook === 'compact' ? 'compact' : 'easy'
      const cattlePerPage = listLook === 'compact' ? 40 : 20
      let textSize = 'standard'
      let spacing = 'standard'
      if (listLook === 'compact') { textSize = 'small'; spacing = 'tight' }
      const allowedSorts = [
        'Ear-tag number (last 5 digits)',
        'Age',
        'Sex'
      ]
      const submittedSort = req.body.sortBy
      const sortBy = allowedSorts.indexOf(submittedSort) !== -1
        ? submittedSort
        : 'Ear-tag number (last 5 digits)'

      req.session.data.vaccinationListLook = listLook
      req.session.data.vaccinationCattlePerPage = cattlePerPage
      req.session.data.previewTextSize = textSize
      req.session.data.previewSpacing = spacing
      req.session.data.previewOrientation = 'portrait'
      req.session.data.vaccinationSortBy = sortBy
      return res.redirect(`/${version}/download-list`)
    }

    const downloadFormat = req.body.downloadFormat || req.session.data.downloadFormat || 'pdf'
    const selectedOptions = normalisePreviewOptions(req.body.previewOptions || [], req.session.data.fields)
    const selectedFields = availableListColumns.filter(field => selectedOptions.includes(field))

    req.session.data.downloadFormat = downloadFormat
    req.session.data.previewTextSize = req.body.previewTextSize || 'standard'
    req.session.data.previewOrientation = req.body.previewOrientation || 'portrait'
    req.session.data.previewSpacing = req.body.previewSpacing || 'standard'
    req.session.data.previewOptions = selectedOptions
    req.session.data.fields = selectedFields
    req.session.data.sortBy = req.body.sortBy || req.session.data.sortBy || 'Ear-tag number'
    req.session.data.sortDirection = req.body.sortDirection || req.session.data.sortDirection || 'asc'

    res.redirect(`/${version}/download-list`)
  })

  // Confirmation / success page after the v1-2 vaccination list is
  // formatted. Mirrors /v1-2/skin-test-list-confirmed but with text
  // and onward-journey links relevant to a vaccination visit.
  router.get(`/${version}/download-list-confirmed`, function (req, res) {
    if ((version !== 'v1-2' && !isV13Plus(version))) {
      return res.redirect(`/${version}/download-list`)
    }
    // Track that a vaccination list has been prepared for this farm
    // so the dashboard / farm-tasks page can offer "Report BCG
    // vaccinations" as the natural next task.
    const cph = req.session.data.selectedCattle
    if (cph) {
      const prepared = Array.isArray(req.session.data.vaccinationListPrepared)
        ? req.session.data.vaccinationListPrepared
        : []
      if (!prepared.find(function (r) { return r && r.cph === cph })) {
        prepared.push({ cph: cph })
        req.session.data.vaccinationListPrepared = prepared
      }
    }
    res.render(`${version}/download-list-confirmed`)
  })

  router.get(`/${version}/download-list/reset`, function (req, res) {
    if ((version === 'v1-2' || isV13Plus(version))) {
      req.session.data.vaccinationListLook = 'easy'
      req.session.data.vaccinationCattlePerPage = 20
      req.session.data.previewTextSize = 'standard'
      req.session.data.previewSpacing = 'standard'
      req.session.data.previewOrientation = 'portrait'
      req.session.data.vaccinationSortBy = 'Ear-tag number (last 5 digits)'
      return res.redirect(`/${version}/download-list`)
    }

    const fields = normaliseFields(req.session.data.fields)

    req.session.data.downloadFormat = req.session.data.downloadFormat || 'pdf'
    req.session.data.previewTextSize = 'standard'
    req.session.data.previewOrientation = 'portrait'
    req.session.data.previewSpacing = 'standard'
    req.session.data.previewOptions = ['show-last-five', ...fields]

    res.redirect(`/${version}/download-list`)
  })

  router.get(`/${version}/download-list`, function (req, res) {
    // v1-2 vaccination list mirrors the v1-2 skin-test-list page:
    // paginated A4 sheets, boxed last-4 ear tag, "list look" disclosure,
    // blank "Additional cattle" page at the end. Render the v1-2-only
    // template with enriched rows (earTagParts, isDuplicate,
    // isVaccinated, vaccinationDate) and the same paging variables.
    if ((version === 'v1-2' || isV13Plus(version))) {
      const selectedCattleV12 = req.session.data.selectedCattle
      const sortByV12 = req.session.data.vaccinationSortBy
        || 'Ear-tag number (last 5 digits)'
      const baseAnimalsV12 = (function () {
        const animalsList = getAnimalsForSelection(selectedCattleV12, version)
        // Mirror getSkinTestAnimals's v1-2 sort: last-4 then full last-5
        // so duplicate boxed-last-4 animals always sit together.
        if (sortByV12 === 'Ear-tag number (last 5 digits)') {
          return [...animalsList].sort(function (a, b) {
            const aId = String(a.earTagNumber || '')
            const bId = String(b.earTagNumber || '')
            const aKey = aId.slice(-4) + ':' + aId.slice(-5)
            const bKey = bId.slice(-4) + ':' + bId.slice(-5)
            return aKey.localeCompare(bKey)
          })
        }
        return sortAnimals(animalsList, sortByV12, 'asc')
      })()

      // Enrich each animal with the flags the v1-2 list template uses.
      // The duplicate ear-tag underline and the "recently vaccinated"
      // TB Vax underline are scoped to Mill House Farm only for the
      // demo. Other farms render the list without these flags so the
      // page stays a clean printable list. The "recently vaccinated"
      // window is also tightened from 12 months to 11 months for the
      // demo – animals vaccinated 11 months ago or less get the
      // highlight.
      const isMillHouseFarmV12 = selectedCattleV12 === '12/312/6802'
      const last4Counts = {}
      baseAnimalsV12.forEach(function (a) {
        const last4 = String(a.officialId || '').slice(-4)
        last4Counts[last4] = (last4Counts[last4] || 0) + 1
      })
      // Helpers for the Eligibility column on Mill House Farm. The
      // column rolls five states into a single label so the vet sees
      // each animal's vaccination position at a glance:
      //
      //   "Eligible"                       – unvaccinated AND 42+
      //                                      days old on the date
      //                                      the list is printed.
      //   "Eligible on DD/MM/YYYY"         – under 42 days old on
      //                                      the date the list is
      //                                      printed. The shown date
      //                                      is DOB + 42 days.
      //   "Vaccinated"                     – vaccinated within the
      //                                      last 46 weeks (still
      //                                      has 6+ weeks of cover
      //                                      before revaccination).
      //   "Revaccination due DD/MM/YYYY"   – vaccinated more than
      //                                      46 weeks but less than
      //                                      1 calendar year ago.
      //                                      The shown date is the
      //                                      original vaccination
      //                                      date + 1 year.
      //   "Revaccination overdue"          – vaccinated more than
      //                                      1 calendar year ago.
      const REVAX_DUE_DAYS = 46 * 7  // 46 weeks = 322 days
      function parseDobDate (dob) {
        if (!dob || typeof dob !== 'string') return null
        const parts = dob.split('/')
        if (parts.length !== 3) return null
        const d = parseInt(parts[0], 10)
        const m = parseInt(parts[1], 10)
        const y = parseInt(parts[2], 10)
        if (!d || !m || !y) return null
        return new Date(y, m - 1, d)
      }
      function parseMmYyToDate (mmYY) {
        if (!mmYY || typeof mmYY !== 'string') return null
        const parts = mmYY.split('/')
        if (parts.length !== 2) return null
        const month = parseInt(parts[0], 10)
        const year2 = parseInt(parts[1], 10)
        if (isNaN(month) || isNaN(year2)) return null
        const fullYear = year2 < 100 ? 2000 + year2 : year2
        // Anchor to the 1st of the vaccination month – MM/YY is the
        // finest granularity the prototype captures.
        return new Date(fullYear, month - 1, 1)
      }
      function daysBetween (earlier, later) {
        return (later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000)
      }
      function formatDayMonthYear (date) {
        const dd = String(date.getDate()).padStart(2, '0')
        const mm = String(date.getMonth() + 1).padStart(2, '0')
        const yy = date.getFullYear()
        return `${dd}/${mm}/${yy}`
      }
      function computeEligibilityLabel (animal) {
        if (!isMillHouseFarmV12) return 'Eligible'

        const today = new Date()

        // 1 & 2. Age check first – applies to every animal regardless
        // of vaccination status.
        const dob = parseDobDate(animal.dob)
        if (dob) {
          const eligibleOn = new Date(dob.getTime() + 42 * 24 * 60 * 60 * 1000)
          if (eligibleOn > today) {
            return 'Eligible on ' + formatDayMonthYear(eligibleOn)
          }
        }

        // 3. Unvaccinated animals that are 42+ days old → "Eligible".
        if (animal.vaccinationStatus !== 'Vaccinated' || !animal.vaccinationDate) {
          return 'Eligible'
        }

        // 4 & 5. Vaccinated animals – bucket by days since the last
        // recorded vaccination (anchored to the 1st of the recorded
        // MM/YY).
        const vaxDate = parseMmYyToDate(animal.vaccinationDate)
        if (!vaxDate) return 'Vaccinated'

        const revaxDueDate = new Date(vaxDate)
        revaxDueDate.setFullYear(revaxDueDate.getFullYear() + 1)

        // "Revaccination overdue" – more than one calendar year ago.
        if (today > revaxDueDate) {
          return 'Revaccination overdue'
        }

        // "Revaccination due [date]" – over 46 weeks but still within
        // a year. The displayed date is when revaccination is due
        // (the original vaccination date + 1 calendar year).
        const daysSince = daysBetween(vaxDate, today)
        if (daysSince > REVAX_DUE_DAYS) {
          return 'Revaccination due ' + formatDayMonthYear(revaxDueDate)
        }

        // Default for a vaccinated animal still inside the 46-week
        // protection window.
        return 'Vaccinated'
      }

      // Helper: true when the vaccinated animal sits in the
      // "Revaccination due" window (between 46 weeks and 1 year since
      // vaccination). Used to underline the TB Vax cell so the vet
      // spots the approaching revaccination deadline at a glance.
      function isRevaxDueWindow (animal) {
        if (animal.vaccinationStatus !== 'Vaccinated' || !animal.vaccinationDate) return false
        const vaxDate = parseMmYyToDate(animal.vaccinationDate)
        if (!vaxDate) return false
        const today = new Date()
        const revaxDueDate = new Date(vaxDate)
        revaxDueDate.setFullYear(revaxDueDate.getFullYear() + 1)
        if (today > revaxDueDate) return false
        return daysBetween(vaxDate, today) > REVAX_DUE_DAYS
      }

      const enrichedV12 = baseAnimalsV12.map(function (a) {
        const last4 = String(a.officialId || '').slice(-4)
        const vaxDate = a.vaccinationDate || ''
        return Object.assign({}, a, {
          isDuplicate: isMillHouseFarmV12 && last4Counts[last4] > 1,
          isVaccinated: a.vaccinationStatus === 'Vaccinated',
          vaccinationDate: vaxDate,
          // Underline the TB Vax cell when the animal sits in the
          // "Revaccination due" window (46 weeks – 1 year since
          // vaccination). Scoped to Mill House Farm only for the demo.
          isRecentlyVaccinated: isMillHouseFarmV12 && isRevaxDueWindow(a),
          // Full eligibility label rendered in the Eligibility
          // column. On non-Mill-House farms every animal reads as
          // a plain "Eligible".
          eligibilityLabel: computeEligibilityLabel(a)
        })
      })

      const visibleColumnsV12 = ['DOB', 'Sex', 'Breed']
      const previewRowsV12 = buildPreviewRows(enrichedV12, visibleColumnsV12)
        .map(function (row, idx) {
          return Object.assign({}, row, {
            isDuplicate: enrichedV12[idx].isDuplicate,
            isVaccinated: enrichedV12[idx].isVaccinated,
            vaccinationDate: enrichedV12[idx].vaccinationDate,
            isRecentlyVaccinated: enrichedV12[idx].isRecentlyVaccinated,
            eligibilityLabel: enrichedV12[idx].eligibilityLabel
          })
        })

      return res.render(`${version}/download-list`, {
        previewRows: previewRowsV12,
        previewCount: previewRowsV12.length,
        previewColumns: visibleColumnsV12,
        previewOptions: ['show-last-five'].concat(visibleColumnsV12),
        emphasiseLastFive: true,
        previewTextSize: req.session.data.previewTextSize || 'standard',
        previewOrientation: req.session.data.previewOrientation || 'portrait',
        previewSpacing: req.session.data.previewSpacing || 'standard',
        downloadFormat: req.session.data.downloadFormat || 'pdf',
        pageSize: req.session.data.vaccinationCattlePerPage || 20,
        cattlePerPage: req.session.data.vaccinationCattlePerPage || 20,
        listLook: req.session.data.vaccinationListLook || 'easy',
        totalCattle: previewRowsV12.length,
        sortByLabel: (function () {
          const s = sortByV12
          if (s === 'Age') return 'age'
          if (s === 'Sex') return 'sex'
          return 'ear tag'
        })(),
        currentPage: Math.max(1, parseInt((req.query && req.query.page) || '1', 10) || 1)
      })
    }

    const selectedCattle = req.session.data.selectedCattle
    const fields = normaliseFields(req.session.data.fields)
    const sortBy = req.session.data.sortBy || 'Ear-tag number'
    const sortDirection = req.session.data.sortDirection || 'asc'
    const downloadFormat = req.session.data.downloadFormat || 'pdf'
    const animals = sortAnimals(getAnimalsForSelection(selectedCattle, version), sortBy, sortDirection)
    const previewSettings = getPreviewSettings(req.session.data, fields)

    res.render(`${version}/download-list`, {
      previewRows: buildPreviewRows(animals, previewSettings.visibleColumns),
      previewColumns: previewSettings.visibleColumns,
      previewAnimals: animals,
      previewTextSize: previewSettings.previewTextSize,
      previewOrientation: previewSettings.previewOrientation,
      previewSpacing: previewSettings.previewSpacing,
      previewOptions: previewSettings.previewOptions,
      previewAllColumns: previewSettings.allColumns,
      emphasiseLastFive: previewSettings.emphasiseLastFive,
      downloadFormat,
      downloadFormatLabel: downloadFormat === 'csv' ? 'CSV' : 'Printable list (PDF)',
      sortDirectionLabel: sortDirection === 'desc' ? 'Descending' : 'Ascending',
      printedDate: new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      }).format(new Date()),
      activePreviewTags: buildActivePreviewTags({
        downloadFormat,
        previewTextSize: previewSettings.previewTextSize,
        previewOrientation: previewSettings.previewOrientation,
        previewSpacing: previewSettings.previewSpacing,
        emphasiseLastFive: previewSettings.emphasiseLastFive,
        visibleColumns: previewSettings.visibleColumns
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Dashboard route – shows Start new work + Continue existing work
  // ---------------------------------------------------------------------------
  // Build the dashboard's two lists from real session state: farms with
  // work still in progress, and reports the vet has recently completed.
  // Shared by the dashboard (which previews the top 3 of each) and the
  // full-list "View all" pages.
  function buildDashboardData(req) {
    // The dashboard groups MY work by FARM. We only show real
    // session-tracked work – no demo / placeholder rows. Every entry
    // here is something the current vet has actually started or
    // finished in this session.
    const farmTasksByCph = {}
    function ensureFarmEntry(farm, cph, user) {
      if (!farmTasksByCph[cph]) {
        farmTasksByCph[cph] = {
          farm,
          cph,
          user: user || 'You',
          tasks: [],
          preparedAt: null
        }
      }
      return farmTasksByCph[cph]
    }
    // Track the most-recent prepared-list timestamp per farm so the
    // dashboard row can read "List prepared on 24 April 2026 by You".
    function recordPreparedAt(entry, preparedAt) {
      if (!preparedAt) return
      if (!entry.preparedAt || new Date(preparedAt) > new Date(entry.preparedAt)) {
        entry.preparedAt = preparedAt
      }
    }

    const currentUser = (req.session.data && req.session.data.userName) || 'You'

    // Build a herd lookup for the prepared-list flags (which only
    // store CPH strings) so we can resolve the farm name + cattle
    // count for the dashboard row.
    function lookupHerd(cph) {
      const live = req.session.data.herd
      if (live && live.cph === cph) return live
      return herdData[cph] || { farm: 'Selected farm', cph }
    }

    // 1. In-progress skin test report (live mid-flow data).
    if (req.session.data.skinTestInProgress && req.session.data.herd) {
      const herd = req.session.data.herd
      const phase = req.session.data.currentSkinTestPhase || 'sicct'
      // The V5 variants record everything on one screen, so resuming means
      // going back to that screen. Without this the vet is bounced through
      // two retired pages to arrive at the same place.
      const resumeHref = (version === 'v1-4')
        ? `/${version}/skin-test-reactors`
        : (version === 'v1-5')
          ? `/${version}/skin-test-reactions`
          : (phase === 'diva'
            ? `/${version}/skin-test-diva`
            : `/${version}/skin-test-measurements`)
      ensureFarmEntry(herd.farm, herd.cph, currentUser).tasks.push({
        key: 'report-skin-test',
        title: 'Report skin test results' + (phase === 'diva' ? ' (DIVA)' : ''),
        status: 'In progress',
        actionText: 'Continue recording results',
        href: resumeHref
      })
    }

    // 1b. Open part tests (v1-3). The herd's skin test was filed as a
    //     part test, so it stays on the work list with the remaining
    //     animals still to test on a return visit.
    if (isV13Plus(version)) {
      const partTests = req.session.data.skinTestPartTests || {}
      Object.keys(partTests).forEach(function (cph) {
        const record = partTests[cph]
        if (!record || !record.stillToTest) return
        const herd = lookupHerd(cph)
        const entry = ensureFarmEntry(record.farm || herd.farm, cph, currentUser)
        recordPreparedAt(entry, record.submittedAt)
        entry.tasks.push({
          key: 'part-test-return',
          title: 'Test remaining cattle (part test) – ' + record.stillToTest + ' ' + (record.stillToTest === 1 ? 'animal' : 'animals') + ' still to test',
          description: record.stillToTest + ' ' + (record.stillToTest === 1 ? 'animal' : 'animals') + ' still to test on a return visit.',
          status: 'Part test',
          actionText: 'Test remaining cattle',
          href: `/${version}/farm-tasks/resume?cph=` + encodeURIComponent(cph) + '&task=report-skin-test'
        })
      })
    }

    // 2. Prepared skin-test lists – the only "ready to do" task on
    //    the dashboard is the matching report. View / edit / reprint
    //    of the list itself lives on the farm-tasks page that the
    //    farm row links to.
    const preparedSkinTest = Array.isArray(req.session.data.skinTestListPrepared)
      ? req.session.data.skinTestListPrepared
      : []
    preparedSkinTest.forEach(function (record) {
      const herd = lookupHerd(record.cph)
      const entry = ensureFarmEntry(herd.farm, herd.cph, currentUser)
      recordPreparedAt(entry, record.preparedAt)
      entry.tasks.push({
        key: 'report-skin-test',
        title: 'Report skin test results',
        description: 'Enter Day 1 and Day 2 measurements for each animal.',
        status: 'Ready',
        actionText: 'Report skin test results',
        href: `/${version}/farm-tasks/resume?cph=` + encodeURIComponent(record.cph)
          + '&task=report-skin-test'
      })
    })

    // 3. Prepared vaccination lists – same pattern, the only "ready"
    //    task is the BCG vaccination report.
    const preparedVaccination = Array.isArray(req.session.data.vaccinationListPrepared)
      ? req.session.data.vaccinationListPrepared
      : []
    preparedVaccination.forEach(function (record) {
      const herd = lookupHerd(record.cph)
      const entry = ensureFarmEntry(herd.farm, herd.cph, currentUser)
      recordPreparedAt(entry, record.preparedAt)
      entry.tasks.push({
        key: 'report-vaccinations',
        title: 'Report BCG vaccinations',
        description: 'Record BCG vaccinations you have completed at this farm.',
        status: 'Ready',
        actionText: 'Report BCG vaccinations',
        href: `/${version}/farm-tasks/resume?cph=` + encodeURIComponent(record.cph)
          + '&task=report-vaccinations'
      })
    })

    // Convert the keyed dictionary back to an ordered list. Each farm row
    // reads:
    //   <farm name> - <CPH>              ← link to per-farm task list
    //   <town> - <postcode> - <N cattle> ← supporting location metadata
    //   To do: <next task>               ← the actionable next step
    const dashboardDateFormatter = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })
    const farmsInProgress = Object.keys(farmTasksByCph).map(function (cph) {
      const entry = farmTasksByCph[cph]
      // The "To do" label is the most relevant next step for this farm.
      // Prefer in-progress tasks (the vet should resume those first),
      // otherwise fall back to the first ready task.
      const inProgressTask = entry.tasks.find(function (t) { return t.status === 'In progress' })
      const todoTask = inProgressTask || entry.tasks[0] || null
      return Object.assign({}, entry, {
        titleLine: entry.farm + ' - ' + cph,
        locationLine: farmLocationLine(lookupHerd(cph)),
        todoTitle: todoTask ? todoTask.title : null,
        href: `/${version}/farm-tasks?cph=` + encodeURIComponent(cph)
      })
    })

    // Demo seed: one farm that was fully reported 3 months ago, so the
    // "Recently completed" section isn't empty on a fresh session. Because
    // the report was completed (not a part test) there's no prepared list
    // left for it, so its farm page offers nothing to reprint. Seeded once
    // per session; cleared with the rest of the session data.
    if (isV13Plus(version) && !req.session.data.demoCompletedSeeded) {
      const seedCph = '12/310/6797' // Oak Tree Farm, Skipton
      const seedHerd = herdData[seedCph]
      const day2 = new Date()
      day2.setMonth(day2.getMonth() - 3)
      const day1 = new Date(day2.getFullYear(), day2.getMonth(), day2.getDate() - 3)
      const seeded = Array.isArray(req.session.data.completedReports)
        ? req.session.data.completedReports.slice()
        : []
      if (seedHerd && !seeded.some(function (r) { return r && r.cph === seedCph })) {
        seeded.push({
          cph: seedCph,
          farm: seedHerd.farm,
          type: 'skin-test',
          typeLabel: 'Skin test report',
          completedAt: day2.toISOString(),
          // Snapshot so the report reopens realistically when amended: a
          // clean SICCT test of the whole herd (no reactors, none untested)
          // dated 3 months ago. No per-animal entries, so the check-answers
          // page shows every animal as clear.
          snapshot: {
            selectedCattle: seedCph,
            selectedCattleLabel: seedHerd.farm,
            skinTestType: 'SICCT',
            administeredBy: 'self',
            theirRole: 'vet',
            skinTestReactors: [],
            skinTestUntested: [],
            skinTestUntestedReasons: {},
            skinTestDay1Day: String(day1.getDate()),
            skinTestDay1Month: String(day1.getMonth() + 1),
            skinTestDay1Year: String(day1.getFullYear()),
            skinTestDay2Day: String(day2.getDate()),
            skinTestDay2Month: String(day2.getMonth() + 1),
            skinTestDay2Year: String(day2.getFullYear())
          }
        })
      }
      req.session.data.completedReports = seeded
      req.session.data.demoCompletedSeeded = true
    }

    // Recently completed reports. A filed report moves here from "Work in
    // progress" so the vet keeps a record of it. Sorted most-recent-first
    // for display regardless of how each entry was added.
    const completedRecords = (Array.isArray(req.session.data.completedReports)
      ? req.session.data.completedReports.slice()
      : []).sort(function (a, b) {
      return new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime()
    })
    const completedReports = completedRecords.map(function (r) {
      const herd = lookupHerd(r.cph)
      let completedAtLabel = null
      const d = new Date(r.completedAt)
      if (!isNaN(d.getTime())) completedAtLabel = dashboardDateFormatter.format(d)
      // Completed rows link to the farm page, where the "Completed"
      // section offers the link through to the check-answers summary to
      // review or amend the report.
      const href = `/${version}/farm-tasks?cph=` + encodeURIComponent(r.cph)
      return {
        farm: r.farm || herd.farm,
        cph: r.cph,
        titleLine: (r.farm || herd.farm) + ' - ' + r.cph,
        locationLine: farmLocationLine(herd),
        typeLabel: r.typeLabel,
        completedAtLabel,
        href: href
      }
    })

    return { farmsInProgress, completedReports }
  }

  router.get(`/${version}/dashboard`, function (req, res) {
    const savedBanner = req.session.data.savedBanner
    // Show the banner once, then clear it
    if (savedBanner) {
      req.session.data.savedBanner = null
    }
    const dash = buildDashboardData(req)
    // Preview the 3 most relevant of each list on the dashboard; the full
    // lists live behind the "View all" links.
    const PREVIEW = 3
    res.render(`${version}/dashboard`, {
      farmsInProgress: dash.farmsInProgress.slice(0, PREVIEW),
      workInProgressTotal: dash.farmsInProgress.length,
      showAllWorkInProgress: dash.farmsInProgress.length > PREVIEW,
      completedReports: dash.completedReports.slice(0, PREVIEW),
      completedTotal: dash.completedReports.length,
      showAllCompleted: dash.completedReports.length > PREVIEW
    })
  })

  // Full-list "View all" pages for the two dashboard sections (v1-3).
  if (isV13Plus(version)) {
    router.get(`/${version}/dashboard/work-in-progress`, function (req, res) {
      const dash = buildDashboardData(req)
      res.render(`${version}/dashboard-work-in-progress`, {
        farmsInProgress: dash.farmsInProgress,
        total: dash.farmsInProgress.length
      })
    })
    router.get(`/${version}/dashboard/completed`, function (req, res) {
      const dash = buildDashboardData(req)
      res.render(`${version}/dashboard-completed`, {
        completedReports: dash.completedReports,
        total: dash.completedReports.length
      })
    })

    // Amend a completed report. Loads the farm, restores the snapshot of
    // what was filed into session, then opens the check-answers page so the
    // vet can use its Change links and re-submit. Only skin test reports
    // carry a snapshot; anything else falls back to the farm page.
    router.get(`/${version}/completed-report/amend`, function (req, res) {
      const cph = (req.query && req.query.cph) || ''
      const type = (req.query && req.query.type) || 'skin-test'
      const completed = Array.isArray(req.session.data.completedReports)
        ? req.session.data.completedReports
        : []
      const record = completed.find(function (r) { return r && r.cph === cph && r.type === type })
      const herd = herdData[cph]
      const amendableType = type === 'skin-test' || type === 'vaccination'
      if (!record || !herd || !amendableType || !record.snapshot) {
        return res.redirect(`/${version}/farm-tasks?cph=` + encodeURIComponent(cph))
      }
      req.session.data.selectedCattle = cph
      req.session.data.selectedCattleLabel = herd.farm
      req.session.data.herd = herd
      if (type === 'vaccination') {
        // Reopen the vaccination report exactly as filed on its check-your-
        // answers page, where the vet can use the Change links to amend.
        restoreVaccinationReport(req, record.snapshot)
        return res.redirect(`/${version}/check-report-answers`)
      }
      restoreSkinTestReport(req, record.snapshot)
      return res.redirect(`/${version}/skin-test-confirmation`)
    })
  }

  // ---------------------------------------------------------------------------
  // Farm tasks – a per-farm task list reached from the dashboard. Shows
  // every task related to that farm in a single GOV.UK task list, so the
  // vet can see what's done, what's in progress, and what still needs
  // doing without hunting around the rest of the service.
  // ---------------------------------------------------------------------------
  router.get(`/${version}/farm-tasks`, function (req, res) {
    const cph = (req.query && req.query.cph) || (req.session.data && req.session.data.herd && req.session.data.herd.cph)
    if (!cph) {
      return res.redirect(`/${version}/dashboard`)
    }

    // Resolve the farm record. We try the live session selection first,
    // then fall back to the static herd dataset.
    const herdFromSession = req.session.data && req.session.data.herd
    const herd = (herdFromSession && herdFromSession.cph === cph)
      ? herdFromSession
      : (herdData[cph] || null)
    const farmName = (herd && herd.farm) || 'Selected farm'
    const currentUser = (req.session.data && req.session.data.userName) || 'You'

    // Demo seed (v1-2 only): Mill House Farm (12/312/6802) is the
    // mixed-vaccination demo farm. So the prepared-lists block is
    // populated without forcing the vet to walk the full prepare-list
    // journey, auto-seed a "Both" (SICCT + DIVA) skin-test prepared
    // list the first time this farm is opened. Real prepared records
    // created later in the session take precedence because we only
    // seed when no record exists for this CPH yet, and the post-submit
    // cleanup elsewhere strips the record once the report is filed.
    if ((version === 'v1-2' || isV13Plus(version)) && cph === '12/312/6802') {
      const existingSkinTest = Array.isArray(req.session.data.skinTestListPrepared)
        ? req.session.data.skinTestListPrepared
        : []
      const alreadySeeded = existingSkinTest.some(function (r) { return r && r.cph === cph })
      if (!alreadySeeded && !req.session.data.millHouseSkinTestSubmitted) {
        existingSkinTest.push({
          cph: cph,
          types: ['SICCT', 'DIVA'],
          preparedAt: new Date().toISOString()
        })
        req.session.data.skinTestListPrepared = existingSkinTest
      }
    }

    // Build a clean per-farm task list from real session state. After
    // a list is prepared the only "ready to do" task is the matching
    // report. The prepared list itself is shown separately so the vet
    // can view, edit or reprint it without it cluttering the task
    // list.
    const taskItems = []

    function resumeHref(taskKey) {
      return `/${version}/farm-tasks/resume?cph=` + encodeURIComponent(cph)
        + '&task=' + encodeURIComponent(taskKey)
    }

    // "Created" stamp for prepared lists – matches the format printed on
    // the skin-test list (en-GB long weekday + day + month + year) so the
    // row and the printed sheet read identically.
    const preparedListDateFormatter = new Intl.DateTimeFormat('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    })
    function formatLongDate(value) {
      if (!value) return null
      const d = new Date(value)
      if (isNaN(d.getTime())) return null
      return preparedListDateFormatter.format(d)
    }
    function createdHint(preparedAt) {
      const date = formatLongDate(preparedAt)
      return date ? { text: 'Created ' + date } : undefined
    }

    // Open part test (v1-3): the herd's skin test was filed as a part
    // test, so some animals are still to test on a return visit.
    const partTestRecord = (isV13Plus(version)
      && req.session.data.skinTestPartTests
      && req.session.data.skinTestPartTests[cph]) || null

    const preparedSkinTest = Array.isArray(req.session.data.skinTestListPrepared)
      ? req.session.data.skinTestListPrepared
      : []
    const sicctRecord = preparedSkinTest.find(function (r) { return r && r.cph === cph })
    const preparedVaccination = Array.isArray(req.session.data.vaccinationListPrepared)
      ? req.session.data.vaccinationListPrepared
      : []
    const vaxRecord = preparedVaccination.find(function (r) { return r && r.cph === cph })

    // A farm shows only its single most relevant piece of work – the latest
    // job. A job is one report action plus, where there's one, the printable
    // list to take to the farm (so at most two rows). Priority: a report in
    // progress, then an open part test, then the most recently prepared list
    // (skin test or vaccination). Anything else the vet wants to do is
    // reached via the "Do something else at this farm" link, which goes to
    // the choose-a-task page. (govuk-frontend v6 dropped the blue tag
    // modifier, so report actions use the default blue tag and the part test
    // uses yellow to stand out.)
    const readyToPrintTag = { tag: { text: 'Ready to print', classes: 'govuk-tag--grey' } }

    // Build the "print list" row for a prepared skin test record.
    function skinTestListItem(record) {
      const types = Array.isArray(record.types) ? record.types : ['SICCT']
      const hint = createdHint(record.preparedAt)
      const hasSicct = types.indexOf('SICCT') !== -1
      const hasDiva = types.indexOf('DIVA') !== -1
      if (hasSicct && hasDiva) {
        return {
          title: { text: 'SICCT and DIVA list of cattle for skin tests' },
          hint: hint,
          href: `/${version}/skin-test-list?both=1`,
          status: readyToPrintTag
        }
      }
      const label = hasDiva ? 'DIVA' : 'SICCT'
      return {
        title: { text: label + ' list of cattle for skin tests' },
        hint: hint,
        href: `/${version}/skin-test-list?sublist=` + (hasDiva ? 'diva' : 'sicct'),
        status: readyToPrintTag
      }
    }
    function preparedHint(preparedAt) {
      const date = formatLongDate(preparedAt)
      return date ? { text: 'List prepared ' + date } : undefined
    }

    let job = null
    const inProgress = cph === (req.session.data.herd && req.session.data.herd.cph)
      && req.session.data.skinTestInProgress

    if (inProgress) {
      const phase = req.session.data.currentSkinTestPhase || 'sicct'
      // See the note on resumeHref above - V5 resumes on its own screen.
      const resumeFlowHref = (version === 'v1-4')
        ? `/${version}/skin-test-reactors`
        : (version === 'v1-5')
          ? `/${version}/skin-test-reactions`
          : (phase === 'diva'
            ? `/${version}/skin-test-diva`
            : `/${version}/skin-test-measurements`)
      job = {
        report: {
          title: { text: 'Report skin test results' + (phase === 'diva' ? ' (DIVA)' : '') },
          hint: sicctRecord ? preparedHint(sicctRecord.preparedAt) : undefined,
          href: resumeFlowHref,
          status: { tag: { text: 'In progress' } }
        },
        list: sicctRecord ? skinTestListItem(sicctRecord) : null
      }
    } else if (partTestRecord && partTestRecord.stillToTest) {
      const n = partTestRecord.stillToTest
      const animalWord = n === 1 ? 'animal' : 'animals'
      const filedDate = formatLongDate(partTestRecord.submittedAt)
      const countText = n + ' ' + animalWord + ' still to test'
      job = {
        report: {
          title: { text: 'Report on the remaining cattle' },
          hint: { text: filedDate ? (countText + ' · part test submitted ' + filedDate) : (countText + ' on a return visit') },
          href: resumeHref('report-skin-test-remaining'),
          status: { tag: { text: 'Part test', classes: 'govuk-tag--yellow' } }
        },
        list: {
          title: { text: 'List of remaining cattle to test' },
          hint: { text: countText },
          href: `/${version}/part-test-list?cph=` + encodeURIComponent(cph),
          status: readyToPrintTag
        }
      }
    } else {
      // No active work – offer the most recently prepared list (skin test
      // or vaccination) and its report.
      const prepared = []
      if (sicctRecord) {
        prepared.push({
          ts: new Date(sicctRecord.preparedAt || 0).getTime(),
          report: {
            title: { text: 'Report skin test results' },
            hint: preparedHint(sicctRecord.preparedAt),
            href: resumeHref('report-skin-test'),
            status: { tag: { text: 'Not started' } }
          },
          list: skinTestListItem(sicctRecord)
        })
      }
      if (vaxRecord) {
        prepared.push({
          ts: new Date(vaxRecord.preparedAt || 0).getTime(),
          report: {
            title: { text: 'Report BCG vaccinations' },
            hint: preparedHint(vaxRecord.preparedAt),
            href: resumeHref('report-vaccinations'),
            status: { tag: { text: 'Not started' } }
          },
          list: {
            title: { text: 'List of cattle to vaccinate' },
            hint: createdHint(vaxRecord.preparedAt),
            href: `/${version}/download-list`,
            status: readyToPrintTag
          }
        })
      }
      prepared.sort(function (a, b) { return b.ts - a.ts })
      job = prepared[0] || null
    }

    if (job) {
      taskItems.push(job.report)
      if (job.list) taskItems.push(job.list)
    }

    // Reports already filed for this farm. Shown as "Completed" items the
    // vet can click to reopen the check-answers summary and change data.
    const completedForFarm = (Array.isArray(req.session.data.completedReports)
      ? req.session.data.completedReports
      : []).filter(function (r) { return r && r.cph === cph })
    const completedItems = completedForFarm.map(function (r) {
      const canAmend = (r.type === 'skin-test' || r.type === 'vaccination') && r.snapshot
      const submittedDate = formatLongDate(r.completedAt)
      return {
        title: { text: r.typeLabel || 'Report' },
        hint: submittedDate ? { text: 'Submitted ' + submittedDate } : undefined,
        href: canAmend
          ? `/${version}/completed-report/amend?cph=` + encodeURIComponent(cph) + '&type=' + encodeURIComponent(r.type)
          : undefined,
        status: { text: 'Completed' }
      }
    })

    res.render(`${version}/farm-tasks`, {
      farmName,
      cph,
      locationLine: farmLocationLine(herd),
      newTaskHref: `/${version}/farm-tasks/new?cph=` + encodeURIComponent(cph),
      currentUser,
      taskItems,
      completedItems
    })
  })

  // "Do something else at this farm" – load the herd into session and send
  // the vet to the choose-a-task page, where they pick what they want to do
  // (prepare or report a vaccination or skin test) for this farm.
  if (isV13Plus(version)) {
    router.get(`/${version}/farm-tasks/new`, function (req, res) {
      const cph = (req.query && req.query.cph) || ''
      const herd = herdData[cph]
      if (!herd) {
        return res.redirect(`/${version}/dashboard`)
      }
      req.session.data.selectedCattle = cph
      req.session.data.selectedCattleLabel = herd.farm
      req.session.data.herd = herd
      return res.redirect(`/${version}/select-visit-task`)
    })
  }

  // Resume endpoint – sets up the session for the chosen farm and task
  // and forwards the vet to the matching journey start. Used by the
  // "Continue ..." / "Start ..." links on /v1-1/farm-tasks so demo
  // tasks land somewhere meaningful instead of "#".
  router.get(`/${version}/farm-tasks/resume`, function (req, res) {
    const cph = (req.query && req.query.cph) || ''
    const task = (req.query && req.query.task) || ''
    if (!cph || !task) {
      return res.redirect(`/${version}/dashboard`)
    }

    // Load the herd into session so downstream pages have the data
    // they need (farm name in captions, CPH in summary lists, etc.).
    const herd = herdData[cph]
    if (herd) {
      req.session.data.selectedCattle = cph
      req.session.data.selectedCattleLabel = herd.farm
      req.session.data.herd = herd
    } else {
      // Unknown CPH – bounce to the dashboard rather than risk a half-
      // initialised journey.
      return res.redirect(`/${version}/dashboard`)
    }

    // Any resume other than a scoped return visit operates on the full
    // herd, so clear any leftover part-test scope up front. The
    // report-skin-test-remaining case below re-applies it.
    req.session.data.skinTestScopeIds = null

    // Set the journey-specific state and redirect to the right entry
    // page. Mirrors what /v1-1/select-journey does, but keyed on the
    // task identifier we put on the farm-tasks page.
    switch (task) {
      case 'prepare-vaccinate':
        req.session.data.journey = 'prepare-vaccinate'
        req.session.data.listType = 'Vaccinate cattle'
        if (!normaliseFields(req.session.data.fields).length) {
          req.session.data.fields = availableListColumns
        }
        req.session.data.downloadFormat = req.session.data.downloadFormat || 'pdf'
        req.session.data.sortBy = req.session.data.sortBy || 'Ear-tag number'
        req.session.data.sortDirection = req.session.data.sortDirection || 'asc'
        req.session.data.previewOptions = req.session.data.previewOptions
          || ['show-last-five', ...availableListColumns]
        return res.redirect(`/${version}/download-list`)

      case 'report-vaccinations':
        req.session.data.journey = 'report-vaccination'
        req.session.data.reportType = 'vaccination'
        return res.redirect(`/${version}/who-gave-the-vaccine`)

      case 'prepare-skin-test':
        req.session.data.journey = 'prepare-skin-test'
        req.session.data.listType = 'Give skin test'
        req.session.data.prepareSkinTestType = null
        req.session.data.prepareSkinTestPhase = null
        // v1-2 inserts the "How would you like to view your list?"
        // step before doing the auto-setup, so the vet can pick PDF /
        // Spreadsheet / Handheld first.
        if ((version === 'v1-2' || isV13Plus(version))) {
          return res.redirect(`/${version}/list-format`)
        }
        return res.redirect(`/${version}/prepare-skin-test-type`)

      case 'report-skin-test':
        req.session.data.journey = 'report-skin-test'
        req.session.data.reportType = 'tb-test'
        // Keep any saved partial state so an in-progress report can
        // resume; only reset if there's nothing already in session for
        // this farm.
        if (!req.session.data.skinTestInProgress) {
          req.session.data.skinTestEntries = null
          req.session.data.skinTestAddedEntries = null
          req.session.data.skinTestDay1Day = null
          req.session.data.skinTestDay1Month = null
          req.session.data.skinTestDay1Year = null
          req.session.data.skinTestDay2Day = null
          req.session.data.skinTestDay2Month = null
          req.session.data.skinTestDay2Year = null
          req.session.data.skinTestType = null
          req.session.data.currentSkinTestIndex = 0
          req.session.data.skinTestInProgress = true
        }
        return res.redirect(`/${version}/who-gave-the-vaccine`)

      case 'report-skin-test-remaining': {
        // Return visit for an open part test. Scope the whole report to
        // the animals recorded as still to test, and start a fresh report
        // over just those animals.
        const partTests = req.session.data.skinTestPartTests || {}
        const record = partTests[cph]
        const remaining = record && Array.isArray(record.remainingIds)
          ? record.remainingIds
          : []
        if (!remaining.length) {
          return res.redirect(`/${version}/farm-tasks?cph=` + encodeURIComponent(cph))
        }
        req.session.data.skinTestScopeIds = remaining
        req.session.data.journey = 'report-skin-test'
        req.session.data.reportType = 'tb-test'
        // Fresh return-visit report – clear any earlier report state so we
        // start clean over the remaining animals only.
        req.session.data.skinTestEntries = null
        req.session.data.skinTestAddedEntries = null
        req.session.data.skinTestReactors = null
        req.session.data.skinTestUntested = null
        req.session.data.skinTestUntestedReasons = null
        req.session.data.skinTestDay1Day = null
        req.session.data.skinTestDay1Month = null
        req.session.data.skinTestDay1Year = null
        req.session.data.skinTestDay2Day = null
        req.session.data.skinTestDay2Month = null
        req.session.data.skinTestDay2Year = null
        req.session.data.skinTestType = record.testType || null
        req.session.data.currentSkinTestIndex = 0
        req.session.data.skinTestInProgress = true
        return res.redirect(`/${version}/who-gave-the-vaccine`)
      }

      default:
        return res.redirect(`/${version}/dashboard`)
    }
  })

  // Print/view the list of animals still to test from an open part test.
  // Loads the herd, scopes the animal universe to the recorded remaining
  // set, then hands off to the standard printable skin-test list (which
  // draws its animals from getSkinTestAnimals, so it shows only those
  // animals and the vet can print it for the return visit).
  if (isV13Plus(version)) {
    router.get(`/${version}/part-test-list`, function (req, res) {
      const cph = (req.query && req.query.cph)
        || (req.session.data.herd && req.session.data.herd.cph)
      const partTests = req.session.data.skinTestPartTests || {}
      const record = cph && partTests[cph]
      if (!record || !Array.isArray(record.remainingIds) || !record.remainingIds.length) {
        return res.redirect(`/${version}/dashboard`)
      }
      const herd = herdData[cph]
      if (herd) {
        req.session.data.selectedCattle = cph
        req.session.data.selectedCattleLabel = herd.farm
        req.session.data.herd = herd
      }
      req.session.data.skinTestScopeIds = record.remainingIds
      // Show the remaining animals as a single-test list – clear any
      // prepare-time split / not-tested state that would otherwise filter
      // the printable list.
      req.session.data.prepareSkinTestType = record.testType === 'Both'
        ? 'SICCT'
        : (record.testType || 'SICCT')
      req.session.data.prepareSkinTestPhase = null
      req.session.data.prepareSkinTestAssignments = null
      req.session.data.prepareSkinTestUntested = null
      return res.redirect(`/${version}/skin-test-list?returnVisit=1`)
    })
  }

  // ---------------------------------------------------------------------------
  // Unified journey selector – called from /v1-1/confirm-herd-or-animal.
  // The vet picks one of four journeys; we initialise state and redirect
  // into the matching flow.
  // ---------------------------------------------------------------------------
  // New page showing the four journey radios. The POST handler below
  // lives on /select-journey and sends the vet into the matching flow.
  router.get(`/${version}/select-visit-task`, function (req, res) {
    res.render(`${version}/select-visit-task`)
  })

  router.post(`/${version}/select-journey`, function (req, res) {
    const journey = req.body.journey
    req.session.data.journey = journey
    // A newly selected journey always covers the full herd, so drop any
    // leftover part-test return-visit scope.
    req.session.data.skinTestScopeIds = null

    if (!journey) {
      return res.render(`${version}/select-visit-task`, {
        errors: { journey: { text: 'Select what you will do on this visit' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select what you will do on this visit', href: '#journey' }]
        }
      })
    }

    switch (journey) {
      case 'prepare-vaccinate':
        req.session.data.listType = 'Vaccinate cattle'
        if (!normaliseFields(req.session.data.fields).length) {
          req.session.data.fields = availableListColumns
        }
        req.session.data.downloadFormat = req.session.data.downloadFormat || 'pdf'
        req.session.data.sortBy = req.session.data.sortBy || 'Ear-tag number'
        req.session.data.sortDirection = req.session.data.sortDirection || 'asc'
        req.session.data.previewOptions = req.session.data.previewOptions
          || ['show-last-five', ...availableListColumns]
        // v1-2 inserts a "How would you like to view your list?" step
        // (PDF / Spreadsheet / Handheld) before either the filter page
        // or a direct download. Other versions skip straight to the
        // download/list page.
        if ((version === 'v1-2' || isV13Plus(version))) {
          return res.redirect(`/${version}/list-format`)
        }
        return res.redirect(`/${version}/download-list`)

      case 'prepare-skin-test':
        req.session.data.listType = 'Give skin test'
        // Sequential flow: the vet picks the list type up front, then
        // formats that list. For "Both", they return through the
        // confirmation step to format the second list. Reset any prior
        // state so a new journey always starts clean.
        req.session.data.prepareSkinTestType = null
        req.session.data.prepareSkinTestPhase = null
        req.session.data.prepareSkinTestTypeManuallyChosen = null
        req.session.data.prepareSkinTestChoice = null
        // v1-3 inserts a recommended-vs-manual picker before the list
        // format step so the vet can either accept APHA's recommended
        // test type (derived from herd vaccination status) or pick the
        // test types themselves.
        if (isV13Plus(version)) {
          return res.redirect(`/${version}/prepare-skin-test-recommendation`)
        }
        // v1-2 has no manual "which test" page – the type is derived
        // from the herd's vaccination status. The auto-setup happens
        // after the vet picks an output format on /v1-2/list-format,
        // so we redirect there instead of going straight to the list.
        if (version === 'v1-2') {
          return res.redirect(`/${version}/list-format`)
        }
        return res.redirect(`/${version}/prepare-skin-test-type`)

      case 'report-vaccination':
        req.session.data.reportType = 'vaccination'
        return res.redirect(`/${version}/who-gave-the-vaccine`)

      case 'report-skin-test':
        req.session.data.reportType = 'tb-test'
        // Reset per-report skin test state so a new report starts clean
        req.session.data.skinTestEntries = null
        req.session.data.skinTestAddedEntries = null
        req.session.data.skinTestDay1Day = null
        req.session.data.skinTestDay1Month = null
        req.session.data.skinTestDay1Year = null
        req.session.data.skinTestDay2Day = null
        req.session.data.skinTestDay2Month = null
        req.session.data.skinTestDay2Year = null
        req.session.data.skinTestType = null
        req.session.data.currentSkinTestIndex = 0
        req.session.data.skinTestInProgress = true
        return res.redirect(`/${version}/who-gave-the-vaccine`)
    }

    // Unknown journey – send back to the confirm page
    return res.redirect(`/${version}/confirm-herd-or-animal`)
  })

  // ---------------------------------------------------------------------------
  // v1-2 only: "How would you like to view your list?" – PDF /
  // Spreadsheet / Handheld – inserted after /select-visit-task for the
  // two list-prep journeys (prepare-vaccinate and prepare-skin-test).
  // ---------------------------------------------------------------------------
  router.get(`/${version}/list-format`, function (req, res) {
    if ((version !== 'v1-2' && !isV13Plus(version))) {
      return res.redirect(`/${version}/select-visit-task`)
    }
    res.render(`${version}/list-format`)
  })

  router.post(`/${version}/list-format`, function (req, res) {
    if ((version !== 'v1-2' && !isV13Plus(version))) {
      return res.redirect(`/${version}/select-visit-task`)
    }
    const listFormat = req.body.listFormat
    const journey = req.session.data.journey
    req.session.data.listFormat = listFormat

    if (!listFormat) {
      return res.render(`${version}/list-format`, {
        errors: { listFormat: { text: 'Select how you want to view your list' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select how you want to view your list', href: '#listFormat' }]
        }
      })
    }

    // Handheld – information page only (no list rendered yet). The
    // page itself offers a "Choose another option" button back here.
    if (listFormat === 'handheld') {
      return res.redirect(`/${version}/handheld-info`)
    }

    // PDF or Spreadsheet – record the chosen download format and
    // route into the matching list flow. Spreadsheet skips the
    // filtering step and lands on the *-confirmed page where the CSV
    // download link sits; PDF goes to the filter / preview page so
    // the vet can format the list before printing.
    const downloadFormat = listFormat === 'spreadsheet' ? 'csv' : 'pdf'
    req.session.data.downloadFormat = downloadFormat

    if (journey === 'prepare-skin-test') {
      // Run the v1-2 auto-setup (derive type from vaccination status,
      // pre-populate the SICCT/DIVA split). Without this, the list
      // page bounces back to /select-visit-task because the test type
      // hasn't been set.
      //
      // v1-3 lets the vet choose between the recommended type and a
      // manual override – when they pick manually, the test type and
      // assignments are populated by /prepare-skin-test-type's POST
      // handler, so we skip auto-setup here to avoid overwriting it.
      if (!(isV13Plus(version) && req.session.data.prepareSkinTestTypeManuallyChosen)) {
        autoSetupSkinTestForV12(req, version)
      }
      if (downloadFormat === 'csv') {
        // Spreadsheet flow lands on a dedicated download page that
        // mirrors the PDF confirmation step but is framed around
        // downloading a CSV (now or later from the dashboard).
        return res.redirect(`/${version}/list-spreadsheet`)
      }
      // When both SICCT and DIVA were prepared the vet first picks
      // which list to format and print first. Single-test CPHs skip
      // the picker and go straight to the list.
      if (req.session.data.prepareSkinTestType === 'Both') {
        return res.redirect(`/${version}/skin-test-list-order`)
      }
      return res.redirect(`/${version}/skin-test-list`)
    }

    if (journey === 'prepare-vaccinate') {
      if (downloadFormat === 'csv') {
        return res.redirect(`/${version}/list-spreadsheet`)
      }
      return res.redirect(`/${version}/download-list`)
    }

    // Unknown journey – send back to the visit-task picker.
    return res.redirect(`/${version}/select-visit-task`)
  })

  router.get(`/${version}/handheld-info`, function (req, res) {
    if ((version !== 'v1-2' && !isV13Plus(version))) {
      return res.redirect(`/${version}/select-visit-task`)
    }
    res.render(`${version}/handheld-info`)
  })

  // Spreadsheet download page – mirrors the PDF confirmation step
  // (download now / save for later) but framed around a CSV download.
  // Records the prepared list against the current farm so the
  // dashboard can offer the matching report task as a follow-up.
  router.get(`/${version}/list-spreadsheet`, function (req, res) {
    if ((version !== 'v1-2' && !isV13Plus(version))) {
      return res.redirect(`/${version}/select-visit-task`)
    }
    const cph = req.session.data.selectedCattle
    const journey = req.session.data.journey
    if (cph) {
      if (journey === 'prepare-skin-test') {
        const prepared = Array.isArray(req.session.data.skinTestListPrepared)
          ? req.session.data.skinTestListPrepared.filter(function (r) {
              return r && r.cph !== cph
            })
          : []
        const prepareSkinTestType = req.session.data.prepareSkinTestType || 'SICCT'
        const types = prepareSkinTestType === 'Both'
          ? ['SICCT', 'DIVA']
          : [prepareSkinTestType]
        prepared.push({ cph: cph, types: types, preparedAt: new Date().toISOString() })
        req.session.data.skinTestListPrepared = prepared
      } else if (journey === 'prepare-vaccinate') {
        const prepared = Array.isArray(req.session.data.vaccinationListPrepared)
          ? req.session.data.vaccinationListPrepared
          : []
        if (!prepared.find(function (r) { return r && r.cph === cph })) {
          prepared.push({ cph: cph })
          req.session.data.vaccinationListPrepared = prepared
        }
      }
    }
    res.render(`${version}/list-spreadsheet`)
  })
}

// Register routes for each supported prototype version
// -----------------------------------------------------------------------------
// V5 (v1-4) retired pages
//
// V5 is a part journey: it starts on the review table, so every page that
// would normally come before it has been removed from views/v1-4. Their
// routes are still registered by the shared registerVersionRoutes /
// registerSkinTestRoutes functions, and would throw when they tried to
// render a template that is no longer there. This guard sits in front of
// them and sends anyone who reaches a retired path — an old bookmark, a
// stale link on a page we kept — back to the start of the V5 journey.
//
// Registered before registerVersionRoutes so it runs first. It is scoped
// to /v1-4, so no other version is affected.
// -----------------------------------------------------------------------------
const V14_RETIRED_PATHS = [
  '',
  'start', 'start-service', 'sign-in',
  'one-login', 'one-login-email', 'one-login-password',
  'search', 'search-results',
  'search-for-a-herd-or-animal', 'search-for-a-herd-or-animal-to-report',
  'choose-a-herd-or-animal-to-report',
  'confirm-herd-or-animal', 'confirm-herd-or-animal-to-report',
  'prepare-skin-test-assign', 'prepare-skin-test-assign-cattle',
  'prepare-skin-test-assign-confirm', 'prepare-skin-test-assign-order',
  'prepare-skin-test-recommendation', 'prepare-skin-test-warning',
  'prepare-skin-test-untested', 'prepare-skin-test-untested-confirm',
  'prepare-skin-test-untested-reason',
  'skin-test-list-confirmed', 'skin-test-list-order',
  'download-list', 'download-list-confirmed',
  'list-format', 'list-spreadsheet',
  'handheld-info', 'check-list-details'
]

router.use('/v1-4', function (req, res, next) {
  const firstSegment = String(req.path || '').replace(/^\//, '').split('/')[0]
  if (V14_RETIRED_PATHS.indexOf(firstSegment) !== -1) {
    return res.redirect('/v1-4/skin-test-reactors')
  }
  next()
})

// The "add another" variant is the same part-journey experiment as the
// table variant, so it retires the same set of pages ahead of its entry
// point - everything before the vet starts recording exceptions.
router.use('/v1-5', function (req, res, next) {
  const firstSegment = String(req.path || '').replace(/^\//, '').split('/')[0]
  if (V14_RETIRED_PATHS.indexOf(firstSegment) !== -1) {
    return res.redirect('/v1-5/skin-test-reactions')
  }
  next()
})

registerVersionRoutes('v1-0')
registerVersionRoutes('v1-1')
registerVersionRoutes('v1-2')
registerVersionRoutes('v1-3')
registerVersionRoutes('v1-4')
registerVersionRoutes('v1-5')

// -----------------------------------------------------------------------------
// Skin test journey routes (V1-1 only)
// -----------------------------------------------------------------------------
function registerSkinTestRoutes(version) {
  // v1-2 drops the Age column from the printable skin-test list – the
  // vet works from DOB instead, which is the canonical reference on
  // ear-tag passports.
  const skinTestListColumns = (version === 'v1-2' || isV13Plus(version))
    ? ['DOB', 'Sex', 'Breed']
    : ['Age', 'DOB', 'Sex', 'Breed']

  // v1-3 renames the reactor-measurement page to a test-agnostic URL.
  // "skin-test-diva-table" implied the page was DIVA-only, but it records
  // both SICCT and DIVA readings, so v1-3 serves it at "skin-test-table".
  // Earlier versions keep the original path (and template filename).
  const testTablePath = isV13Plus(version) ? 'skin-test-table' : 'skin-test-diva-table'

  // Helpers --------------------------------------------------------------------

  function getSkinTestAnimals(req) {
    const selectedCattle = req.session.data.selectedCattle
    const sortBy = req.session.data.skinTestSortBy || 'Ear-tag number (last 5 digits)'
    const sortDirection = req.session.data.skinTestSortDirection || 'asc'
    // registerSkinTestRoutes is registered per version – use the
    // closure's version so v1-1 and v1-2 each pull from the right
    // dataset.
    const allAnimals = getAnimalsForSelection(selectedCattle, version)

    // Return-visit scope (v1-3 part test). When the vet resumes a part
    // test to test the animals that were left over, the whole report is
    // limited to that still-to-test set (recorded at submission and held
    // in skinTestScopeIds). This helper is the single point every report,
    // list, reactor and untested page draws its animals from, so filtering
    // here scopes the entire return-visit journey in one place.
    const scopeIds = (isV13Plus(version)
      && Array.isArray(req.session.data.skinTestScopeIds)
      && req.session.data.skinTestScopeIds.length)
      ? new Set(req.session.data.skinTestScopeIds)
      : null
    const animals = scopeIds
      ? allAnimals.filter(function (a) { return scopeIds.has(a.officialId) })
      : allAnimals

    // v1-2 only: sort the default ear-tag list by the boxed last-4
    // digits first, then the full last-5 (the individual number) to
    // break ties. The vet reads cattle off the printed list by the
    // boxed last-4, so animals that share that value must sit
    // together – without the last-4 prefix, a bought-in animal with
    // individual number 10075 (last-4 0075) sorted after 06237 and
    // broke up the 0074 / 0075 sequence on Mill House Farm. v1-1
    // keeps the original last-5-only sort.
    if ((version === 'v1-2' || isV13Plus(version)) && sortBy === 'Ear-tag number (last 5 digits)') {
      const direction = sortDirection === 'desc' ? -1 : 1
      return [...animals].sort(function (a, b) {
        const aId = String(a.earTagNumber || '')
        const bId = String(b.earTagNumber || '')
        const aKey = aId.slice(-4) + ':' + aId.slice(-5)
        const bKey = bId.slice(-4) + ':' + bId.slice(-5)
        return aKey.localeCompare(bKey) * direction
      })
    }

    return sortAnimals(animals, sortBy, sortDirection)
  }

  function blankEntry() {
    return {
      // Per-animal test-type override. The skin-test-type screen sets a
      // whole-journey default ('SICCT' | 'DIVA' | 'Both'), but the
      // measurements page lets the vet switch test on a per-cow basis
      // (for example, if one animal reacted and needs DIVA follow-up).
      // Values: 'SICCT' | 'DIVA' | 'Both'. Empty string falls back to
      // the journey-wide skinTestType.
      performedTest: '',
      // SICCT fields
      status: null,
      avianBeforeInjection: '',
      avianBeforeReading: '',
      avianReactionDescription: '',
      bovineBeforeInjection: '',
      bovineBeforeReading: '',
      bovineReactionDescription: '',
      avianAfter72Hours: '',
      bovineAfter72Hours: '',
      remarks: '',
      // Clinical fields captured alongside the skin measurement grid.
      // Only populated for SICCT and Both journeys – never for DIVA-only.
      reactionDescription: '',
      overallResult: '',          // 'negative' | 'positive' | 'inconclusive'
      // notDoneReason is now a radio value ('not-found' | 'deceased' |
      // 'withdrawn-export' | 'withdrawn-slaughter' | 'withdrawn-owner' |
      // 'other'). When 'other' is chosen the typed reason goes into
      // notDoneReasonOther.
      notDoneReason: '',
      notDoneReasonOther: '',
      // DIVA fields (used when skinTestType is 'DIVA' or 'Both')
      divaStatus: null,           // 'done' | 'not-done'
      divaResult: '',             // 'negative' | 'positive' | 'inconclusive'
      // DIVA is a bovine-only test. We capture the bovine skin thickness
      // at injection (Day 1) and 72 hours later (Day 2), plus a clinical
      // description of any reaction and free-text remarks specific to
      // the DIVA visit. `divaBovineBeforeInjection` / `divaBovineAfter72Hours`
      // are distinct from the SICCT bovine readings because, on the
      // combined "Both" journey, SICCT and DIVA each have their own
      // bovine measurement pair.
      divaBovineBeforeInjection: '',
      divaBovineAfter72Hours: '',
      divaReactionDescription: '',
      divaRemarks: '',
      // Which DIVA batch was used for this animal. Asked on the
      // measurement page only when more than one batch was recorded
      // on /skin-test-type; auto-filled when there's just one.
      divaBatchUsed: '',
      // Same idea for the SICCT batch. Only relevant when the v1-2
      // Both journey lets the vet pick SICCT for a per-animal save
      // and there's more than one SICCT batch on /skin-test-type.
      sicctBatchUsed: '',
      divaNotDoneReason: '',
      divaNotDoneReasonOther: '',
      // Single consolidated notes field shown beneath the measurement +
      // DIVA sections. Replaces the old Remarks / DIVA remarks / extra
      // readings textareas so there's one clear place for extra info.
      additionalNotes: ''
    }
  }

  function getEntries(req) {
    const animals = getSkinTestAnimals(req)
    const existing = Array.isArray(req.session.data.skinTestEntries)
      ? req.session.data.skinTestEntries
      : []

    // Pre-compute duplicate flags the same way the printed list does – any
    // two animals whose last 4 digits match are flagged, so the vet can
    // tell them apart on the measurement screen.
    const lastFourCounts = {}
    animals.forEach(function (a) {
      const last4 = String(a.officialId || '').slice(-4)
      lastFourCounts[last4] = (lastFourCounts[last4] || 0) + 1
    })

    return animals.map((animal, index) => {
      const saved = existing[index] || {}
      const last4 = String(animal.officialId || '').slice(-4)
      // "Check the DOB" flag – any animal whose age sits in a window
      // around the 42-day minimum testing age (35–49 days), so the
      // vet's eye is drawn to borderline calves on the printed list
      // and in every reporting table. ageInMonthsFromDob actually
      // returns days here despite the name.
      const daysOld = ageInMonthsFromDob(animal.dob)
      const isUnderTestAge = typeof daysOld === 'number'
        && daysOld >= 35
        && daysOld <= 49
      // "Check the TB Vax" flag – the last BCG vaccination was around
      // 9 months ago (8–10 months), so a booster is approaching and
      // the vet should confirm the date before testing.
      const vaxMonths = monthsSinceVaxDate(animal.vaccinationDate)
      const isVaxCheckDue = typeof vaxMonths === 'number'
        && vaxMonths >= 8
        && vaxMonths <= 10
      return Object.assign(
        {},
        blankEntry(),
        saved,
        {
          officialId: animal.officialId,
          earTag: animal.officialId,
          earTagParts: formatEarTagParts(animal.officialId),
          breed: animal.breed,
          dob: animal.dob,
          sex: animal.sex,
          age: calculateAgeFromDob(animal.dob),
          isVaccinated: animal.vaccinationStatus === 'Vaccinated',
          isDuplicate: lastFourCounts[last4] > 1,
          isUnderTestAge: isUnderTestAge,
          isVaxCheckDue: isVaxCheckDue,
          index
        }
      )
    })
  }

  function getAddedEntries(req) {
    const added = Array.isArray(req.session.data.skinTestAddedEntries)
      ? req.session.data.skinTestAddedEntries
      : []
    const baseCount = getSkinTestAnimals(req).length
    return added.map((entry, offset) => Object.assign(
      {},
      entry,
      {
        // Mirror the shape of `getEntries`: every entry shown on the
        // confirmation page should carry earTagParts so templates can
        // pick the unique last-4 segment instead of rendering the
        // whole "UK ... " ear tag.
        earTagParts: formatEarTagParts(entry.officialId),
        index: baseCount + offset
      }
    ))
  }

  // Return the entries that apply to a given test phase. For the
  // reporting journey we only loop through REACTORS – the animals the
  // vet ticked on the reactors page – so the measurement screens stay
  // focused on the small number of cattle that need detailed readings.
  // Each returned entry carries an `originalIndex` so POST handlers
  // can write back to the right position in the full skinTestEntries
  // array.
  //
  // We trust the vet's journey-wide test choice (SICCT / DIVA / Both):
  // every reactor goes through whichever phase loop is being shown.
  // For Both, each reactor goes through SICCT and then DIVA. The
  // vaccination-status filter that used to live here was over-stepping
  // and excluding genuine reactors – the same problem we hit on the
  // list-format page.
  // Phase-aware reactor helpers. For SICCT-only and DIVA-only journeys
  // there's a single reactor list. For "Both", each test (SICCT and
  // DIVA) gets its own reactor list because the same animal can react
  // to one but not the other. The active "current phase" is whichever
  // test the vet is being asked about right now.
  function getReactorsForPhase(req, phase) {
    const byPhase = req.session.data.skinTestReactorsByPhase || {}
    if (phase === 'diva' && Array.isArray(byPhase.diva)) return byPhase.diva
    if (phase === 'sicct' && Array.isArray(byPhase.sicct)) return byPhase.sicct
    // Fallback to the legacy single-list key for backwards compatibility
    return Array.isArray(req.session.data.skinTestReactors)
      ? req.session.data.skinTestReactors
      : []
  }

  function setReactorsForPhase(req, phase, ids) {
    const byPhase = Object.assign({}, req.session.data.skinTestReactorsByPhase || {})
    byPhase[phase] = ids
    req.session.data.skinTestReactorsByPhase = byPhase
    // Mirror to the legacy single key so any unrelated code that
    // still reads it sees the latest list.
    req.session.data.skinTestReactors = ids
  }

  function getCurrentReactorPhase(req) {
    const skinTestType = req.session.data.skinTestType || 'SICCT'
    if (skinTestType === 'DIVA') return 'diva'
    if (skinTestType === 'SICCT') return 'sicct'
    // Both – the active phase is whichever phase hasn't completed yet.
    // Default to the vet's chosen first order; flip once that phase
    // is in `completedSkinTestPhases`.
    const firstOrder = req.session.data.skinTestFirstOrder === 'diva' ? 'diva' : 'sicct'
    const completed = Array.isArray(req.session.data.completedSkinTestPhases)
      ? req.session.data.completedSkinTestPhases
      : []
    if (completed.indexOf(firstOrder) === -1) return firstOrder
    return firstOrder === 'sicct' ? 'diva' : 'sicct'
  }

  function getCurrentReactorPhaseLabel(req) {
    return getCurrentReactorPhase(req) === 'diva' ? 'DIVA' : 'SICCT'
  }

  // True when the vet is partway through the v1-2 per-test sub-flow
  // (the new SICCT-then-DIVA loop driven by skin-test-batch-details).
  // When this is on, the combined-Both shortcuts in the reactor and
  // measurement handlers are bypassed so each test runs through its
  // own reactor-pick + measurements + confirm cycle.
  function isPerTestSubFlow(req) {
    const t = req.session.data.currentSkinTest
    return t === 'sicct' || t === 'diva'
  }

  // Animal-ID set for the active test, derived from the prepare-list
  // assignments (SICCT = unvaccinated, DIVA = vaccinated). Used to
  // scope the reactor picker and measurements to a single test.
  function getPerTestAnimalIdSet(req, test) {
    const assignments = req.session.data.prepareSkinTestAssignments || {}
    const ids = Array.isArray(assignments[test]) ? assignments[test] : []
    return new Set(ids)
  }

  // After a test's measurements / "no reactors" answer have been
  // captured, decide where the vet goes next. Used by the per-test
  // confirmation page on submit. If the Both journey still has the
  // other test to run, swap currentSkinTest and send the vet to that
  // test's batch-details. Otherwise the loop is done – clear the
  // active-test marker and continue to the all-tested gate.
  function nextRouteAfterCurrentTest(req, version) {
    const isBoth = req.session.data.skinTestType === 'Both'
    const current = req.session.data.currentSkinTest === 'diva' ? 'diva' : 'sicct'
    const completed = Array.isArray(req.session.data.skinTestCompletedTests)
      ? req.session.data.skinTestCompletedTests.slice()
      : []
    if (completed.indexOf(current) === -1) completed.push(current)
    req.session.data.skinTestCompletedTests = completed

    if (isBoth) {
      const other = current === 'sicct' ? 'diva' : 'sicct'
      if (completed.indexOf(other) === -1) {
        req.session.data.currentSkinTest = other
        // Reset the per-test reactor + measurement pointers for the
        // next test so it starts from a clean slate.
        req.session.data.currentSkinTestIndex = 0
        req.session.data.currentDivaIndex = 0
        return `/${version}/skin-test-batch-details/${other}`
      }
    }

    // All tests done.
    req.session.data.currentSkinTest = null
    return `/${version}/skin-test-all-tested`
  }

  function getEntriesForPhase(req, phase) {
    const all = getEntries(req)
    const reactorIds = getReactorsForPhase(req, phase)
    const reactorSet = new Set(reactorIds)
    return all
      .map(function (entry, originalIndex) {
        return Object.assign({}, entry, { originalIndex })
      })
      .filter(function (entry) {
        return reactorSet.has(entry.officialId)
      })
  }

  function entrySummary(allEntries) {
    return {
      total: allEntries.length,
      done: allEntries.filter(e => e.status === 'done').length,
      notDone: allEntries.filter(e => e.status === 'not-done').length,
      outstanding: allEntries.filter(e => !e.status).length
    }
  }

  function divaSummary(allEntries) {
    return {
      total: allEntries.length,
      done: allEntries.filter(e => e.divaStatus === 'done').length,
      notDone: allEntries.filter(e => e.divaStatus === 'not-done').length,
      outstanding: allEntries.filter(e => !e.divaStatus).length
    }
  }

  function buildPreviewSettings(req) {
    const previewOptions = Array.isArray(req.session.data.skinTestPreviewOptions)
      ? req.session.data.skinTestPreviewOptions
      : ['show-last-five', ...skinTestListColumns]
    const visibleColumns = skinTestListColumns.filter(field => previewOptions.includes(field))
    return {
      previewOptions,
      visibleColumns,
      emphasiseLastFive: previewOptions.includes('show-last-five')
    }
  }

  function formatDateParts(day, month, year) {
    if (!day || !month || !year) {
      return ''
    }
    return `${day}/${month}/${year}`
  }

  // Format a date + 12-hour time triple as "DD/MM/YYYY at H:MM AM/PM".
  // Falls back to date-only if the time pieces are missing (so v1-0 / v1-1
  // sessions, which don't capture a start time, still render correctly).
  function formatDateTimeParts(day, month, year, hour, minute, ampm) {
    const date = formatDateParts(day, month, year)
    if (!date) return ''
    const hourNum = parseInt(hour, 10)
    if (!hour || isNaN(hourNum)) return date
    const min = String(minute || '00').padStart(2, '0')
    const period = ampm === 'PM' ? 'PM' : 'AM'
    return `${date} at ${hourNum}:${min} ${period}`
  }

  // Add hours to a date+time captured as separate parts (day/month/year +
  // 12-hour clock) and return the same shape back. Used to derive Day 2
  // from Day 1 on the v1-2 skin-test-date page (Day 2 is 72 hours after
  // Day 1 unless the vet says the test spanned more than one day).
  function addHoursToDateTimeParts(dayStr, monthStr, yearStr, hourStr, minuteStr, ampm, hoursToAdd) {
    const day = parseInt(dayStr, 10)
    const month = parseInt(monthStr, 10)
    const year = parseInt(yearStr, 10)
    let hour = parseInt(hourStr, 10)
    const minute = parseInt(minuteStr, 10)
    if (!day || !month || !year || isNaN(hour)) return null

    // Convert 12-hour to 24-hour before doing date arithmetic.
    if (ampm === 'PM' && hour < 12) hour += 12
    if (ampm === 'AM' && hour === 12) hour = 0

    const start = new Date(year, month - 1, day, hour, isNaN(minute) ? 0 : minute)
    const end = new Date(start.getTime() + hoursToAdd * 60 * 60 * 1000)

    let endHour24 = end.getHours()
    const endAmpm = endHour24 >= 12 ? 'PM' : 'AM'
    let endHour12 = endHour24 % 12
    if (endHour12 === 0) endHour12 = 12

    return {
      day: String(end.getDate()),
      month: String(end.getMonth() + 1),
      year: String(end.getFullYear()),
      hour: String(endHour12),
      minute: String(end.getMinutes()).padStart(2, '0'),
      ampm: endAmpm
    }
  }

  // Journey 1 – Prepare list of cattle for skin tests -------------------------

  // v1-3 only: recommended-vs-manual picker. After the vet picks
  // "Prepare a list of cattle for skin tests" on /select-visit-task,
  // they land here and either accept the recommended test type
  // (derived from the herd's vaccination status, or from APHA policy
  // when a policy-driven override is in effect) or choose to pick
  // the test types themselves.
  function v13RecommendedTestInfo(req, version) {
    const animals = getAnimalsForSelection(req.session.data.selectedCattle, version)
    const hasVaccinated = animals.some(function (a) { return a.vaccinationStatus === 'Vaccinated' })
    const hasUnvaccinated = animals.some(function (a) { return a.vaccinationStatus !== 'Vaccinated' })

    // Future hook: when an APHA policy mandates DIVA for the whole
    // herd regardless of recorded vaccination status, set
    // req.session.data.policyRecommendsDivaWholeHerd = true to flip
    // the recommendation source from "vaccination records" to
    // "current policy". Off by default.
    const policyDivaWholeHerd = req.session.data.policyRecommendsDivaWholeHerd === true

    let type = 'SICCT'
    if (policyDivaWholeHerd) type = 'DIVA'
    else if (hasVaccinated && hasUnvaccinated) type = 'Both'
    else if (hasVaccinated) type = 'DIVA'

    const labels = { SICCT: 'SICCT only', DIVA: 'DIVA only', Both: 'separate DIVA and SICCT lists' }

    let headline
    if (policyDivaWholeHerd) {
      headline = 'Based on current policy, APHA recommends DIVA for the whole herd.'
    } else if (type === 'Both') {
      headline = 'Based on current vaccination records, APHA recommends separate DIVA and SICCT lists for this herd.'
    } else {
      headline = 'Based on current vaccination records, APHA recommends ' + labels[type] + ' for this herd.'
    }

    let reason
    if (policyDivaWholeHerd) {
      reason = 'A current APHA policy applies to this herd, so DIVA is recommended for every animal regardless of vaccination records.'
    } else if (type === 'DIVA') {
      reason = 'All cattle currently recorded on this farm are BCG vaccinated, so DIVA is recommended for this herd.'
    } else if (type === 'SICCT') {
      reason = 'No cattle currently recorded on this farm are BCG vaccinated, so SICCT is recommended for this herd.'
    } else {
      reason = 'Some cattle currently recorded on this farm are BCG vaccinated and some are not, so APHA recommends preparing both lists.'
    }

    // Three-way herd vaccination state used by the recommendation
    // template to pick the copy and the radio options:
    //   - 'mixed'        – some vaccinated and some unvaccinated animals
    //   - 'vaccinated'   – every animal is BCG vaccinated (overdue-for-
    //                      revaccination animals still count as vaccinated)
    //   - 'unvaccinated' – no animals recorded as vaccinated
    let herdVaxState
    if (hasVaccinated && hasUnvaccinated) herdVaxState = 'mixed'
    else if (hasVaccinated) herdVaxState = 'vaccinated'
    else herdVaxState = 'unvaccinated'

    return {
      type: type,
      label: labels[type],
      headline: headline,
      reason: reason,
      source: policyDivaWholeHerd ? 'policy' : 'vaccination-records',
      hasVaccinated: hasVaccinated,
      herdVaxState: herdVaxState
    }
  }

  router.get(`/${version}/prepare-skin-test-recommendation`, function (req, res) {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/select-visit-task`)
    }
    const info = v13RecommendedTestInfo(req, version)
    req.session.data.recommendedSkinTestType = info.type
    res.render(`${version}/prepare-skin-test-recommendation`, {
      recommendedType: info.type,
      recommendedLabel: info.label,
      recommendedHeadline: info.headline,
      recommendedReason: info.reason,
      recommendedSource: info.source,
      // Drives the warning text and which single test is recommended on
      // the page: vaccinated animals present → DIVA recommended for the
      // whole herd; fully unvaccinated → either test can be used.
      herdHasVaccinated: info.hasVaccinated,
      // Three-way state ('mixed'|'vaccinated'|'unvaccinated') the template
      // uses to choose the copy and the set of skin-test options.
      herdVaxState: info.herdVaxState
    })
  })

  router.post(`/${version}/prepare-skin-test-recommendation`, function (req, res) {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/select-visit-task`)
    }
    const choice = req.body.prepareSkinTestChoice
    req.session.data.prepareSkinTestChoice = choice
    if (!choice) {
      const info = v13RecommendedTestInfo(req, version)
      return res.render(`${version}/prepare-skin-test-recommendation`, {
        recommendedType: info.type,
        recommendedLabel: info.label,
        recommendedHeadline: info.headline,
        recommendedReason: info.reason,
        recommendedSource: info.source,
        herdHasVaccinated: info.hasVaccinated,
        herdVaxState: info.herdVaxState,
        errors: { prepareSkinTestChoice: { text: 'Select which skin tests you want to use' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select which skin tests you want to use', href: '#prepareSkinTestChoice' }]
        }
      })
    }
    if (choice === 'auto-split') {
      // Mixed herd: "DIVA for all vaccinated animals, SICCT for
      // unvaccinated animals". Pre-sort the cattle automatically by
      // vaccination status into the DIVA / SICCT lists – no manual
      // picker – then carry on to list-format. Mirrors the 'Both'
      // branch of autoSetupSkinTestForV12.
      const animals = getAnimalsForSelection(req.session.data.selectedCattle, version)
      const diva = animals
        .filter(function (a) { return a.vaccinationStatus === 'Vaccinated' })
        .map(function (a) { return a.officialId })
      const sicct = animals
        .filter(function (a) { return a.vaccinationStatus !== 'Vaccinated' })
        .map(function (a) { return a.officialId })
      req.session.data.prepareSkinTestType = 'Both'
      req.session.data.prepareSkinTestAssignments = { sicct: sicct, diva: diva }
      req.session.data.prepareAssignCompletedTests = ['sicct', 'diva']
      req.session.data.prepareAssignMode = null
      req.session.data.prepareSkinTestPhase = 'sicct'
      req.session.data.prepareSkinTestUntested = []
      req.session.data.prepareSkinTestUntestedReasons = {}
      req.session.data.prepareSkinTestUntestedReasonOthers = {}
      // Mark as manually chosen so list-format doesn't re-run
      // autoSetup and overwrite these assignments.
      req.session.data.prepareSkinTestTypeManuallyChosen = true
      return res.redirect(`/${version}/list-format`)
    }
    if (choice === 'manual') {
      // "I'll choose which skin test type to use" – the vet sorts the
      // cattle into separate DIVA / SICCT lists themselves. This is the
      // "Both" split flow: start with empty assignments in manual mode
      // and route to list-format, where they pick which list to format
      // first and then assign cattle via the picker. (Mirrors the v1-3
      // "Both" branch of the now-removed prepare-skin-test-type page.)
      req.session.data.prepareSkinTestType = 'Both'
      req.session.data.prepareSkinTestAssignments = { sicct: [], diva: [] }
      req.session.data.prepareAssignCompletedTests = []
      req.session.data.prepareAssignMode = 'manual'
      req.session.data.prepareSkinTestPhase = 'sicct'
      req.session.data.prepareSkinTestUntested = []
      req.session.data.prepareSkinTestUntestedReasons = {}
      req.session.data.prepareSkinTestUntestedReasonOthers = {}
      req.session.data.prepareSkinTestTypeManuallyChosen = true
      return res.redirect(`/${version}/list-format`)
    }
    // "Use the SICCT skin test" / "Use the DIVA skin test" – a single
    // skin test for the whole herd. Set the type explicitly and route
    // to list-format, mirroring the SICCT-only / DIVA-only path from
    // the manual test-type picker.
    const chosenType = choice === 'diva' ? 'DIVA' : 'SICCT'
    req.session.data.prepareSkinTestType = chosenType
    req.session.data.prepareSkinTestPhase = chosenType === 'DIVA' ? 'diva' : 'sicct'
    req.session.data.prepareSkinTestTypeManuallyChosen = true
    // Reset any not-tested / assignment state from a previous run so a
    // fresh single-test list starts clean.
    req.session.data.prepareSkinTestUntested = []
    req.session.data.prepareSkinTestUntestedReasons = {}
    req.session.data.prepareSkinTestUntestedReasonOthers = {}
    req.session.data.prepareSkinTestAssignments = null
    req.session.data.prepareAssignMode = null
    req.session.data.prepareAssignCompletedTests = []
    res.redirect(`/${version}/list-format`)
  })

  // Pre-list step: pick which test the list is for (SICCT / DIVA / Both).
  // The vet then marks any cattle that won't be tested on the next step –
  // there's no separate vaccination-status mismatch warning.
  // v1-2 has no manual "which test" page; the type is derived from the
  // herd's vaccination status. v1-3 has retired this page too – the
  // SICCT / DIVA / split choice is now made directly on
  // prepare-skin-test-recommendation. For both versions, if anyone
  // lands here directly we send them back to the journey selector
  // instead of rendering a removed template.
  router.get(`/${version}/prepare-skin-test-type`, function (req, res) {
    if (version === 'v1-2' || isV13Plus(version)) {
      return res.redirect(`/${version}/select-visit-task`)
    }
    res.render(`${version}/prepare-skin-test-type`)
  })

  router.post(`/${version}/prepare-skin-test-type`, function (req, res) {
    if (version === 'v1-2') {
      // Defensive: the v1-2 flow never POSTs here, but if a stale
      // form somehow does, skip into the auto-setup path.
      autoSetupSkinTestForV12(req, version)
      return res.redirect(`/${version}/skin-test-list`)
    }
    if (isV13Plus(version)) {
      // v1-3 retired this page – the choice is made on
      // prepare-skin-test-recommendation. Bounce any stale POST back to
      // the journey selector.
      return res.redirect(`/${version}/select-visit-task`)
    }
    // The "mixed herd" radio submits the value "DIVA and SICCT". The
    // rest of the journey keys off the canonical "Both" value, so
    // normalise here once.
    const submittedType = req.body.prepareSkinTestType
    const prepareSkinTestType = submittedType === 'DIVA and SICCT'
      ? 'Both'
      : submittedType
    req.session.data.prepareSkinTestType = prepareSkinTestType

    if (!prepareSkinTestType) {
      return res.render(`${version}/prepare-skin-test-type`, {
        errors: { prepareSkinTestType: { text: 'Select which skin test you are preparing a list for' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select which skin test you are preparing a list for', href: '#prepareSkinTestType' }]
        }
      })
    }

    // Reset any not-tested / cattle-assignment state from a previous
    // run so a new journey always starts from a clean slate.
    req.session.data.prepareSkinTestUntested = null
    req.session.data.prepareSkinTestUntestedReasons = null
    req.session.data.prepareSkinTestUntestedReasonOthers = null
    req.session.data.currentPrepareUntestedIndex = 0
    req.session.data.prepareSkinTestAssignments = null
    req.session.data.prepareAssignMode = null
    req.session.data.prepareAssignFirstTest = null
    req.session.data.prepareAssignCurrentTest = null
    req.session.data.prepareAssignCompletedTests = []

    if (prepareSkinTestType === 'Both') {
      // v1-3 manual flow: leave the SICCT / DIVA assignments empty so
      // the vet picks the split themselves via the cattle picker after
      // they've chosen which list to format first on
      // /skin-test-list-order. assignMode = 'manual' opens the picker
      // routes that v1-1 already exposes.
      if (isV13Plus(version)) {
        req.session.data.prepareSkinTestAssignments = { sicct: [], diva: [] }
        req.session.data.prepareAssignCompletedTests = []
        req.session.data.prepareAssignMode = 'manual'
        req.session.data.prepareSkinTestPhase = 'sicct'
        req.session.data.prepareSkinTestUntested = []
        req.session.data.prepareSkinTestUntestedReasons = {}
        req.session.data.prepareSkinTestUntestedReasonOthers = {}
        req.session.data.prepareSkinTestTypeManuallyChosen = true
        return res.redirect(`/${version}/list-format`)
      }
      // v1-2: the SICCT and DIVA cattle are split into two printable
      // lists. Derive the default split from vaccination status (so
      // each animal's Test column is pre-populated) and land the vet
      // on the list page.
      if (version === 'v1-2') {
        const animals = getSkinTestAnimals(req)
        const sicct = animals
          .filter(function (a) { return a.vaccinationStatus !== 'Vaccinated' })
          .map(function (a) { return a.officialId })
        const diva = animals
          .filter(function (a) { return a.vaccinationStatus === 'Vaccinated' })
          .map(function (a) { return a.officialId })
        req.session.data.prepareSkinTestAssignments = { sicct, diva }
        req.session.data.prepareAssignCompletedTests = ['sicct', 'diva']
        req.session.data.prepareSkinTestPhase = 'sicct'
        req.session.data.prepareSkinTestUntested = []
        req.session.data.prepareSkinTestUntestedReasons = {}
        req.session.data.prepareSkinTestUntestedReasonOthers = {}
        return res.redirect(`/${version}/skin-test-list`)
      }
      // v1-1 and earlier: the vet first decides how to split the herd
      // between the SICCT and DIVA lists – auto (by vaccination
      // status) or manual.
      req.session.data.prepareSkinTestPhase = 'sicct'
      return res.redirect(`/${version}/prepare-skin-test-assign`)
    }

    // SICCT-only or DIVA-only: skip the mark-untested page entirely
    // and go straight to the list-format page. The vet can still mark
    // cattle as not-tested from there if needed.
    req.session.data.prepareSkinTestPhase = prepareSkinTestType === 'SICCT' ? 'sicct' : 'diva'
    req.session.data.prepareSkinTestUntested = []
    req.session.data.prepareSkinTestUntestedReasons = {}
    req.session.data.prepareSkinTestUntestedReasonOthers = {}
    if (isV13Plus(version)) {
      req.session.data.prepareSkinTestTypeManuallyChosen = true
      return res.redirect(`/${version}/list-format`)
    }
    res.redirect(`/${version}/skin-test-list`)
  })

  // --- Prepare-list cattle assignment for "Both" ------------------------
  // When the vet picks "DIVA and SICCT" on prepare-skin-test-type they
  // come here to split the herd between the two lists. They can let
  // the system do it automatically (vaccinated → DIVA, unvaccinated →
  // SICCT) or pick the cattle for each test by hand.
  router.get(`/${version}/prepare-skin-test-assign`, function (req, res) {
    // v1-2 doesn't use this page – the SICCT/DIVA split is derived
    // automatically by autoSetupSkinTestForV12. Drop straight onto
    // the combined list if anyone hits this URL.
    if ((version === 'v1-2' || isV13Plus(version))) {
      return res.redirect(`/${version}/skin-test-list`)
    }
    if (req.session.data.prepareSkinTestType !== 'Both') {
      return res.redirect(`/${version}/prepare-skin-test-type`)
    }
    res.render(`${version}/prepare-skin-test-assign`)
  })

  router.post(`/${version}/prepare-skin-test-assign`, function (req, res) {
    const prepareAssignMode = req.body.prepareAssignMode
    req.session.data.prepareAssignMode = prepareAssignMode

    if (prepareAssignMode !== 'auto' && prepareAssignMode !== 'manual') {
      return res.render(`${version}/prepare-skin-test-assign`, {
        errors: { prepareAssignMode: { text: 'Select how you want to assign cattle to each test' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select how you want to assign cattle to each test', href: '#prepareAssignMode' }]
        }
      })
    }

    if (prepareAssignMode === 'auto') {
      // Split by vaccination status without further vet input.
      const animals = getSkinTestAnimals(req)
      const sicct = animals.filter(a => a.vaccinationStatus !== 'Vaccinated').map(a => a.officialId)
      const diva = animals.filter(a => a.vaccinationStatus === 'Vaccinated').map(a => a.officialId)
      req.session.data.prepareSkinTestAssignments = { sicct, diva }
      req.session.data.prepareAssignCompletedTests = ['sicct', 'diva']
      // Skip the mark-untested page and go straight to the list page.
      req.session.data.prepareSkinTestUntested = []
      req.session.data.prepareSkinTestUntestedReasons = {}
      req.session.data.prepareSkinTestUntestedReasonOthers = {}
      return res.redirect(`/${version}/skin-test-list`)
    }

    // Manual – pick the order, then assign per-test.
    req.session.data.prepareSkinTestAssignments = { sicct: [], diva: [] }
    req.session.data.prepareAssignCompletedTests = []
    res.redirect(`/${version}/prepare-skin-test-assign-order`)
  })

  router.get(`/${version}/prepare-skin-test-assign-order`, function (req, res) {
    if (req.session.data.prepareAssignMode !== 'manual') {
      return res.redirect(`/${version}/prepare-skin-test-assign`)
    }
    res.render(`${version}/prepare-skin-test-assign-order`)
  })

  router.post(`/${version}/prepare-skin-test-assign-order`, function (req, res) {
    const prepareAssignFirstTest = req.body.prepareAssignFirstTest
    req.session.data.prepareAssignFirstTest = prepareAssignFirstTest

    if (prepareAssignFirstTest !== 'sicct' && prepareAssignFirstTest !== 'diva') {
      return res.render(`${version}/prepare-skin-test-assign-order`, {
        errors: { prepareAssignFirstTest: { text: 'Select which test you want to choose cattle for first' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select which test you want to choose cattle for first', href: '#prepareAssignFirstTest' }]
        }
      })
    }

    req.session.data.prepareAssignCurrentTest = prepareAssignFirstTest
    res.redirect(`/${version}/prepare-skin-test-assign-cattle`)
  })

  // The cattle picker shows the animals still up for grabs (in the
  // first pass that's everyone; in the second pass it's the cattle
  // that weren't ticked for the first test). The vet ticks the ones
  // they want on the active test's list.
  router.get(`/${version}/prepare-skin-test-assign-cattle`, function (req, res) {
    if (req.session.data.prepareAssignMode !== 'manual') {
      return res.redirect(`/${version}/prepare-skin-test-assign`)
    }
    const currentTest = req.session.data.prepareAssignCurrentTest
    if (currentTest !== 'sicct' && currentTest !== 'diva') {
      return res.redirect(`/${version}/prepare-skin-test-assign-order`)
    }
    const otherTest = currentTest === 'sicct' ? 'diva' : 'sicct'
    const completed = Array.isArray(req.session.data.prepareAssignCompletedTests)
      ? req.session.data.prepareAssignCompletedTests
      : []
    const isSecondPass = completed.indexOf(otherTest) !== -1
    const assignments = req.session.data.prepareSkinTestAssignments || { sicct: [], diva: [] }
    const otherAssigned = new Set(assignments[otherTest] || [])

    // First pass: every animal is on the table. Second pass: only the
    // animals not picked for the first test (i.e. not in otherAssigned).
    const allAnimals = getPrepareCandidateAnimals(req)
    const animals = isSecondPass
      ? allAnimals.filter(a => !otherAssigned.has(a.officialId))
      : allAnimals

    const assignListLook = req.session.data.prepareAssignListLook || 'easy'
    res.render(`${version}/prepare-skin-test-assign-cattle`, {
      currentTestLabel: currentTest === 'diva' ? 'DIVA' : 'SICCT',
      otherTestLabel: otherTest === 'diva' ? 'DIVA' : 'SICCT',
      isSecondPass,
      animals,
      totalCattle: animals.length,
      listLook: assignListLook,
      cattlePerPage: assignListLook === 'compact' ? 40 : 20,
      selectedAssigned: assignments[currentTest] || [],
      backHref: isSecondPass
        ? `/${version}/prepare-skin-test-assign-cattle`
        : `/${version}/prepare-skin-test-assign-order`,
      sortBy: req.session.data.prepareSkinTestUntestedSortBy || 'Ear-tag number (last 5 digits)',
      sortDirection: req.session.data.prepareSkinTestUntestedSortDirection || 'asc'
    })
  })

  router.post(`/${version}/prepare-skin-test-assign-cattle`, function (req, res) {
    const currentTest = req.session.data.prepareAssignCurrentTest
    if (currentTest !== 'sicct' && currentTest !== 'diva') {
      return res.redirect(`/${version}/prepare-skin-test-assign-order`)
    }

    // Filter the Prototype Kit's "_unchecked" placeholder.
    const submitted = Array.isArray(req.body.assignedCattle)
      ? req.body.assignedCattle
      : (req.body.assignedCattle ? [req.body.assignedCattle] : [])
    const assigned = submitted.filter(function (id) {
      return id && id !== '_unchecked'
    })

    const assignments = Object.assign(
      { sicct: [], diva: [] },
      req.session.data.prepareSkinTestAssignments || {}
    )
    assignments[currentTest] = assigned

    const otherTest = currentTest === 'sicct' ? 'diva' : 'sicct'

    // v1-3 manual + Both: one-pass picker. Unticked animals fall to
    // the other list automatically. Continue to a confirm page that
    // shows both lists, then on to /skin-test-list.
    if (isV13Plus(version) && req.session.data.prepareSkinTestTypeManuallyChosen) {
      const assignedSet = new Set(assigned)
      const otherAssigned = getPrepareCandidateAnimals(req)
        .filter(function (a) { return !assignedSet.has(a.officialId) })
        .map(function (a) { return a.officialId })
      assignments[otherTest] = otherAssigned
      req.session.data.prepareSkinTestAssignments = assignments
      req.session.data.prepareAssignCompletedTests = ['sicct', 'diva']
      // Phase is the first chosen list – /skin-test-list reads it to
      // know which sub-list to show on entry.
      req.session.data.prepareSkinTestPhase =
        req.session.data.prepareAssignFirstTest || currentTest
      req.session.data.prepareSkinTestUntested = []
      req.session.data.prepareSkinTestUntestedReasons = {}
      req.session.data.prepareSkinTestUntestedReasonOthers = {}
      return res.redirect(`/${version}/prepare-skin-test-assign-confirm`)
    }

    req.session.data.prepareSkinTestAssignments = assignments

    const completed = Array.isArray(req.session.data.prepareAssignCompletedTests)
      ? req.session.data.prepareAssignCompletedTests.slice()
      : []
    if (completed.indexOf(currentTest) === -1) completed.push(currentTest)
    req.session.data.prepareAssignCompletedTests = completed

    if (completed.indexOf(otherTest) === -1) {
      // Move on to the second test, with the remaining cattle.
      req.session.data.prepareAssignCurrentTest = otherTest
      return res.redirect(`/${version}/prepare-skin-test-assign-cattle`)
    }

    // Both tests assigned – skip the mark-untested page and go
    // straight to the list page. The vet can mark cattle as not-tested
    // from there if needed.
    req.session.data.prepareSkinTestUntested = []
    req.session.data.prepareSkinTestUntestedReasons = {}
    req.session.data.prepareSkinTestUntestedReasonOthers = {}
    res.redirect(`/${version}/skin-test-list`)
  })

  // List-settings POST – persist the chosen sort and bounce back so
  // applying a new sort doesn't disturb the tick state on the main form.
  router.post(`/${version}/prepare-skin-test-assign-cattle/settings`, function (req, res) {
    req.session.data.prepareSkinTestUntestedSortBy = req.body.sortBy || 'Ear-tag number (last 5 digits)'
    req.session.data.prepareSkinTestUntestedSortDirection = req.body.sortDirection || 'asc'
    req.session.data.prepareAssignListLook = req.body.listLook === 'compact' ? 'compact' : 'easy'
    res.redirect(`/${version}/prepare-skin-test-assign-cattle`)
  })

  router.get(`/${version}/prepare-skin-test-assign-cattle/settings/reset`, function (req, res) {
    req.session.data.prepareSkinTestUntestedSortBy = 'Ear-tag number (last 5 digits)'
    req.session.data.prepareSkinTestUntestedSortDirection = 'asc'
    req.session.data.prepareAssignListLook = 'easy'
    res.redirect(`/${version}/prepare-skin-test-assign-cattle`)
  })

  // --- Edit a single list's cattle assignment after the fact ------------
  // Reached from the "Change SICCT list" / "Change DIVA list" links on
  // the skin-test-list page. Lets the vet re-pick cattle for one test
  // without going through the whole two-pass assignment flow again.
  router.get(`/${version}/prepare-skin-test-assign-cattle/edit/:test`, function (req, res) {
    const test = req.params.test === 'diva' ? 'diva' : 'sicct'
    const otherTest = test === 'diva' ? 'sicct' : 'diva'
    const assignments = req.session.data.prepareSkinTestAssignments || { sicct: [], diva: [] }

    const editAnimals = getPrepareCandidateAnimals(req)
    const editListLook = req.session.data.prepareAssignListLook || 'easy'
    res.render(`${version}/prepare-skin-test-assign-cattle`, {
      currentTestLabel: test === 'diva' ? 'DIVA' : 'SICCT',
      otherTestLabel: otherTest === 'diva' ? 'DIVA' : 'SICCT',
      isSecondPass: false,
      isEditMode: true,
      editTest: test,
      animals: editAnimals,
      totalCattle: editAnimals.length,
      listLook: editListLook,
      cattlePerPage: editListLook === 'compact' ? 40 : 20,
      selectedAssigned: assignments[test] || [],
      backHref: `/${version}/skin-test-list`,
      sortBy: req.session.data.prepareSkinTestUntestedSortBy || 'Ear-tag number (last 5 digits)',
      sortDirection: req.session.data.prepareSkinTestUntestedSortDirection || 'asc'
    })
  })

  router.post(`/${version}/prepare-skin-test-assign-cattle/edit/:test`, function (req, res) {
    const test = req.params.test === 'diva' ? 'diva' : 'sicct'

    const submitted = Array.isArray(req.body.assignedCattle)
      ? req.body.assignedCattle
      : (req.body.assignedCattle ? [req.body.assignedCattle] : [])
    const assigned = submitted.filter(function (id) {
      return id && id !== '_unchecked'
    })

    const assignments = Object.assign(
      { sicct: [], diva: [] },
      req.session.data.prepareSkinTestAssignments || {}
    )
    assignments[test] = assigned
    req.session.data.prepareSkinTestAssignments = assignments

    // Make sure both tests are still flagged complete so the
    // skin-test-list page reads the assignments without bouncing
    // the vet back into the first-time flow.
    req.session.data.prepareAssignCompletedTests = ['sicct', 'diva']

    res.redirect(`/${version}/skin-test-list?sublist=` + (test === 'diva' ? 'diva' : 'sicct'))
  })

  // v1-3 only: confirm page shown after the vet picks cattle for the
  // first chosen list. Summarises the SICCT and DIVA splits (the
  // other list is auto-populated with the unticked animals) and lets
  // the vet edit either side before continuing to /skin-test-list.
  router.get(`/${version}/prepare-skin-test-assign-confirm`, function (req, res) {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/skin-test-list`)
    }
    const assignments = req.session.data.prepareSkinTestAssignments || { sicct: [], diva: [] }
    const allAnimals = getPrepareCandidateAnimals(req)
    const byId = {}
    allAnimals.forEach(function (a) { byId[a.officialId] = a })

    function lookup(ids) {
      return (ids || [])
        .map(function (id) { return byId[id] })
        .filter(function (a) { return !!a })
    }

    const sicctAnimals = lookup(assignments.sicct)
    const divaAnimals = lookup(assignments.diva)
    const firstTest = req.session.data.prepareAssignFirstTest === 'diva' ? 'diva' : 'sicct'

    // Vaccination summary per list. SICCT is the recommended test for
    // unvaccinated cattle, so any vaccinated animal on a SICCT list is
    // a mismatch; DIVA is the recommended test for vaccinated cattle,
    // so any unvaccinated animal on a DIVA list is a mismatch.
    function summarise(animals, listType) {
      const vaccinated = animals.filter(function (a) { return a.isVaccinated }).length
      const unvaccinated = animals.length - vaccinated
      const mismatchCount = listType === 'sicct' ? vaccinated : unvaccinated
      const mismatchLabel = listType === 'sicct' ? 'DIVA' : 'SICCT'
      return {
        total: animals.length,
        vaccinated: vaccinated,
        unvaccinated: unvaccinated,
        mismatchCount: mismatchCount,
        mismatchLabel: mismatchLabel
      }
    }

    res.render(`${version}/prepare-skin-test-assign-confirm`, {
      sicctSummary: summarise(sicctAnimals, 'sicct'),
      divaSummary: summarise(divaAnimals, 'diva'),
      firstTest: firstTest,
      firstTestLabel: firstTest === 'diva' ? 'DIVA' : 'SICCT',
      otherTestLabel: firstTest === 'diva' ? 'SICCT' : 'DIVA',
      backHref: `/${version}/prepare-skin-test-assign-cattle`
    })
  })

  router.post(`/${version}/prepare-skin-test-assign-confirm`, function (req, res) {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/skin-test-list`)
    }
    // Make sure both tests are flagged complete so the list page reads
    // the assignments without bouncing the vet back into the picker.
    req.session.data.prepareAssignCompletedTests = ['sicct', 'diva']
    res.redirect(`/${version}/skin-test-list`)
  })

  // --- Prepare-list "not tested" picker --------------------------------
  // Mirrors the report-side untested flow: first the vet ticks every
  // animal that won't be tested on this visit, then loops through each
  // ticked animal to record a reason, then confirms the not-tested
  // list before moving on to the list-format settings page.
  //
  // The list of cattle on this page can be re-sorted via a "List
  // settings" panel (same pattern used on /v1-1/skin-test-list). The
  // chosen sort is held in session so it persists across submits.
  function getPrepareCandidateAnimals(req) {
    // Show every animal on the farm regardless of the chosen test
    // type. Whether a cow gets tested or not is the vet's call.
    const baseAnimals = getSkinTestAnimals(req).map(function (a) { return a })

    // Apply the user-chosen sort. Falls back to "last 5 digits" /
    // ascending if nothing has been picked yet.
    const sortBy = req.session.data.prepareSkinTestUntestedSortBy
      || 'Ear-tag number (last 5 digits)'
    const sortDirection = req.session.data.prepareSkinTestUntestedSortDirection || 'asc'
    const sorted = sortAnimals(baseAnimals, sortBy, sortDirection)

    // Enrich each animal with the same fields the table needs.
    const lastFourCounts = {}
    sorted.forEach(function (a) {
      const last4 = String(a.officialId || '').slice(-4)
      lastFourCounts[last4] = (lastFourCounts[last4] || 0) + 1
    })
    return sorted.map(function (a) {
      const last4 = String(a.officialId || '').slice(-4)
      return Object.assign({}, a, {
        earTagParts: formatEarTagParts(a.officialId),
        age: calculateAgeFromDob(a.dob),
        isDuplicate: lastFourCounts[last4] > 1,
        isVaccinated: a.vaccinationStatus === 'Vaccinated',
        vaccinationDate: a.vaccinationDate || ''
      })
    })
  }

  router.get(`/${version}/prepare-skin-test-untested`, function (req, res) {
    if (!req.session.data.prepareSkinTestType) {
      // v1-2: the type page no longer exists – send them back to the
      // journey picker so the auto-setup runs again.
      if ((version === 'v1-2' || isV13Plus(version))) {
        return res.redirect(`/${version}/select-visit-task`)
      }
      return res.redirect(`/${version}/prepare-skin-test-type`)
    }
    // The "Skip — every animal will be tested" link points here with
    // ?skip=1. Nothing to confirm – clear the not-tested state and
    // route straight to the list-format page.
    if (req.query && req.query.skip === '1') {
      req.session.data.prepareSkinTestUntested = []
      req.session.data.prepareSkinTestUntestedReasons = {}
      req.session.data.prepareSkinTestUntestedReasonOthers = {}
      return res.redirect(`/${version}/skin-test-list`)
    }
    const animals = getPrepareCandidateAnimals(req)
    const selectedUntested = Array.isArray(req.session.data.prepareSkinTestUntested)
      ? req.session.data.prepareSkinTestUntested
      : []
    res.render(`${version}/prepare-skin-test-untested`, {
      animals,
      selectedUntested,
      sortBy: req.session.data.prepareSkinTestUntestedSortBy || 'Ear-tag number (last 5 digits)',
      sortDirection: req.session.data.prepareSkinTestUntestedSortDirection || 'asc'
    })
  })

  // List-settings POST: persist the chosen sort and bounce back to the
  // mark-untested page. The vet's existing tick state is left alone.
  router.post(`/${version}/prepare-skin-test-untested/settings`, function (req, res) {
    req.session.data.prepareSkinTestUntestedSortBy = req.body.sortBy || 'Ear-tag number (last 5 digits)'
    req.session.data.prepareSkinTestUntestedSortDirection = req.body.sortDirection || 'asc'
    res.redirect(`/${version}/prepare-skin-test-untested`)
  })

  router.get(`/${version}/prepare-skin-test-untested/settings/reset`, function (req, res) {
    req.session.data.prepareSkinTestUntestedSortBy = 'Ear-tag number (last 5 digits)'
    req.session.data.prepareSkinTestUntestedSortDirection = 'asc'
    res.redirect(`/${version}/prepare-skin-test-untested`)
  })

  router.post(`/${version}/prepare-skin-test-untested`, function (req, res) {
    // The Prototype Kit injects a "_unchecked" placeholder when a
    // checkboxes group is submitted with nothing ticked. Filter it
    // out so an empty submission really comes through as an empty
    // list (and routes the vet to the confirm page, not the reason
    // loop with a non-existent id).
    const submitted = Array.isArray(req.body.untested)
      ? req.body.untested
      : (req.body.untested ? [req.body.untested] : [])
    const untested = submitted.filter(function (id) {
      return id && id !== '_unchecked'
    })

    req.session.data.prepareSkinTestUntested = untested

    // Prune stale reasons for animals the vet has unticked.
    const existingReasons = req.session.data.prepareSkinTestUntestedReasons || {}
    const existingOthers = req.session.data.prepareSkinTestUntestedReasonOthers || {}
    const prunedReasons = {}
    const prunedOthers = {}
    untested.forEach(function (id) {
      if (existingReasons[id]) prunedReasons[id] = existingReasons[id]
      if (existingOthers[id]) prunedOthers[id] = existingOthers[id]
    })
    req.session.data.prepareSkinTestUntestedReasons = prunedReasons
    req.session.data.prepareSkinTestUntestedReasonOthers = prunedOthers
    req.session.data.currentPrepareUntestedIndex = 0

    if (untested.length === 0) {
      // No cattle marked – nothing to confirm. Skip the confirm step
      // and go straight to the list-format page.
      return res.redirect(`/${version}/skin-test-list`)
    }
    res.redirect(`/${version}/prepare-skin-test-untested-reason/0`)
  })

  // Per-animal reason loop – one page per ticked animal.
  function getPrepareUntestedAnimals(req) {
    const ids = Array.isArray(req.session.data.prepareSkinTestUntested)
      ? req.session.data.prepareSkinTestUntested
      : []
    if (ids.length === 0) return []
    const idSet = new Set(ids)
    return getReportingAnimalsWithFlags(req).filter(a => idSet.has(a.officialId))
  }

  function renderPrepareUntestedReason(req, res, index, options) {
    const animals = getPrepareUntestedAnimals(req)
    const total = animals.length
    if (total === 0) return res.redirect(`/${version}/prepare-skin-test-untested`)

    const safeIndex = Math.max(0, Math.min(index, total - 1))
    const currentAnimal = animals[safeIndex]
    const reasons = req.session.data.prepareSkinTestUntestedReasons || {}
    const others = req.session.data.prepareSkinTestUntestedReasonOthers || {}

    const completedCount = animals.filter(a => reasons[a.officialId]).length
    const progressPercent = total > 0 ? Math.round((completedCount / total) * 100) : 0

    const backHref = safeIndex > 0
      ? `/${version}/prepare-skin-test-untested-reason/${safeIndex - 1}`
      : `/${version}/prepare-skin-test-untested`

    res.render(`${version}/prepare-skin-test-untested-reason`, {
      currentIndex: safeIndex,
      currentPosition: safeIndex + 1,
      totalUntested: total,
      completedCount,
      remainingCount: total - completedCount,
      progressPercent,
      currentAnimal,
      savedReason: reasons[currentAnimal.officialId] || '',
      savedReasonOther: others[currentAnimal.officialId] || '',
      backHref,
      errors: options && options.errors,
      errorSummary: options && options.errorSummary,
      formValues: (options && options.formValues) || {}
    })
  }

  router.get(`/${version}/prepare-skin-test-untested-reason`, function (req, res) {
    const resumeIndex = Number.isInteger(req.session.data.currentPrepareUntestedIndex)
      ? req.session.data.currentPrepareUntestedIndex
      : 0
    res.redirect(`/${version}/prepare-skin-test-untested-reason/${resumeIndex}`)
  })

  router.get(`/${version}/prepare-skin-test-untested-reason/:index`, function (req, res) {
    const animals = getPrepareUntestedAnimals(req)
    if (animals.length === 0) {
      return res.redirect(`/${version}/prepare-skin-test-untested`)
    }
    const index = Math.max(0, Math.min(parseInt(req.params.index, 10) || 0, animals.length - 1))
    req.session.data.currentPrepareUntestedIndex = index
    renderPrepareUntestedReason(req, res, index)
  })

  router.post(`/${version}/prepare-skin-test-untested-reason/:index`, function (req, res) {
    const animals = getPrepareUntestedAnimals(req)
    if (animals.length === 0) {
      return res.redirect(`/${version}/prepare-skin-test-untested`)
    }

    const index = Math.max(0, Math.min(parseInt(req.params.index, 10) || 0, animals.length - 1))
    const currentAnimal = animals[index]
    const reason = (req.body.reason || '').trim()
    const reasonOther = (req.body.reasonOther || '').trim()

    if (!reason) {
      return renderPrepareUntestedReason(req, res, index, {
        errors: { reason: { text: 'Select a reason this animal will not be tested' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select a reason this animal will not be tested', href: '#reason' }]
        },
        formValues: { reason, reasonOther }
      })
    }

    const reasons = Object.assign({}, req.session.data.prepareSkinTestUntestedReasons || {})
    const others = Object.assign({}, req.session.data.prepareSkinTestUntestedReasonOthers || {})
    reasons[currentAnimal.officialId] = reason
    if (reason === 'other') {
      others[currentAnimal.officialId] = reasonOther
    } else {
      delete others[currentAnimal.officialId]
    }
    req.session.data.prepareSkinTestUntestedReasons = reasons
    req.session.data.prepareSkinTestUntestedReasonOthers = others

    if (index < animals.length - 1) {
      const nextIndex = index + 1
      req.session.data.currentPrepareUntestedIndex = nextIndex
      return res.redirect(`/${version}/prepare-skin-test-untested-reason/${nextIndex}`)
    }

    req.session.data.currentPrepareUntestedIndex = animals.length - 1
    res.redirect(`/${version}/prepare-skin-test-untested-confirm`)
  })

  // --- Confirm the not-tested list before moving on to formatting ------
  const PREPARE_UNTESTED_REASON_LABELS = {
    'too-young': 'Cattle too young',
    'deceased': 'Cattle deceased',
    'withdrawn-export': 'Withdrawn for export',
    'withdrawn-slaughter': 'Withdrawn for slaughter',
    'withdrawn-owner': 'Withdrawn by the livestock owner',
    'other': 'Other reason'
  }

  router.get(`/${version}/prepare-skin-test-untested-confirm`, function (req, res) {
    const ids = Array.isArray(req.session.data.prepareSkinTestUntested)
      ? req.session.data.prepareSkinTestUntested
      : []
    const reasons = req.session.data.prepareSkinTestUntestedReasons || {}
    const others = req.session.data.prepareSkinTestUntestedReasonOthers || {}
    const idSet = new Set(ids)
    const untestedRows = getReportingAnimalsWithFlags(req)
      .filter(a => idSet.has(a.officialId))
      .map(function (a) {
        return {
          officialId: a.officialId,
          earTagParts: a.earTagParts,
          age: a.age,
          dob: a.dob,
          sex: a.sex,
          breed: a.breed,
          reason: reasons[a.officialId] || '',
          reasonLabel: PREPARE_UNTESTED_REASON_LABELS[reasons[a.officialId]] || 'No reason',
          reasonOther: reasons[a.officialId] === 'other' ? (others[a.officialId] || '') : ''
        }
      })

    res.render(`${version}/prepare-skin-test-untested-confirm`, {
      untestedRows
    })
  })

  router.post(`/${version}/prepare-skin-test-untested-confirm`, function (req, res) {
    res.redirect(`/${version}/skin-test-list`)
  })

  // --- Picker: which list to print first (v1-2 Both only) --------------
  // Shown between /v1-2/list-format and /v1-2/skin-test-list when both
  // tests were prepared for the CPH. The vet's choice is stored on
  // `prepareSkinTestListFirstOrder` so the second pass through the
  // confirmed page knows which list still needs running, and copied
  // to `prepareSkinTestPhase` so the list page renders the chosen
  // test on entry.
  router.get(`/${version}/skin-test-list-order`, function (req, res) {
    if ((version !== 'v1-2' && !isV13Plus(version))) {
      return res.redirect(`/${version}/skin-test-list`)
    }
    if (req.session.data.prepareSkinTestType !== 'Both') {
      // Not a Both CPH – the picker doesn't apply.
      return res.redirect(`/${version}/skin-test-list`)
    }
    res.render(`${version}/skin-test-list-order`)
  })

  router.post(`/${version}/skin-test-list-order`, function (req, res) {
    if ((version !== 'v1-2' && !isV13Plus(version))) {
      return res.redirect(`/${version}/skin-test-list`)
    }
    const choice = req.body.prepareSkinTestListFirstOrder === 'diva'
      ? 'diva'
      : (req.body.prepareSkinTestListFirstOrder === 'sicct' ? 'sicct' : null)
    if (!choice) {
      return res.render(`${version}/skin-test-list-order`, {
        errors: { prepareSkinTestListFirstOrder: { text: 'Select which list you want to format first' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select which list you want to format first', href: '#prepareSkinTestListFirstOrder' }]
        }
      })
    }
    req.session.data.prepareSkinTestListFirstOrder = choice
    req.session.data.prepareSkinTestPhase = choice
    // Reset the per-list confirmation tracker so each fresh entry
    // through the picker starts from a clean slate.
    req.session.data.prepareSkinTestListConfirmedPhases = []
    // v1-3 manual flow: route into the cattle picker so the vet picks
    // which animals go on the first chosen list. The picker auto-fills
    // the other list with the unticked animals on submit.
    if (isV13Plus(version) && req.session.data.prepareSkinTestTypeManuallyChosen) {
      req.session.data.prepareAssignMode = 'manual'
      req.session.data.prepareAssignFirstTest = choice
      req.session.data.prepareAssignCurrentTest = choice
      req.session.data.prepareAssignCompletedTests = []
      req.session.data.prepareSkinTestAssignments = { sicct: [], diva: [] }
      return res.redirect(`/${version}/prepare-skin-test-assign-cattle`)
    }
    res.redirect(`/${version}/skin-test-list`)
  })

  router.get(`/${version}/skin-test-list`, function (req, res) {
    // V5 links to this page directly from the prototype index, so nothing
    // upstream has chosen a farm or a test. Seed the same defaults the
    // review table uses, so the printed list and the on-screen list are
    // the same herd in the same order.
    if (version === 'v1-4') {
      v14SeedListSession(req, res)
    }
    const baseAnimals = getSkinTestAnimals(req)

    // Determine which sub-list we're currently preparing. For SICCT /
    // DIVA only, the phase is fixed. For "Both", the session phase
    // tells us whether we're on the SICCT list (step 1 of 2) or the
    // DIVA list (step 2 of 2). A ?sublist=sicct|diva query param
    // overrides this – used by the final "Both" confirmation page to
    // let the vet jump between the two prepared lists.
    const prepareSkinTestType = req.session.data.prepareSkinTestType || 'SICCT'
    const sublistOverride = req.query && req.query.sublist
    const sessionPhase = req.session.data.prepareSkinTestPhase
      || (prepareSkinTestType === 'DIVA' ? 'diva' : 'sicct')
    const prepareSkinTestPhase = (sublistOverride === 'sicct' || sublistOverride === 'diva')
      ? sublistOverride
      : sessionPhase
    const isBoth = prepareSkinTestType === 'Both'

    // Populated-list mode: fill every row with deterministic demo answers
    // (handwritten style) so the vet can print a completed example for
    // usability testing. Triggered by the "Generate a populated list" link.
    const populate = !!(req.query && req.query.populate)

    // Small helper so we can build a filtered preview for SICCT, DIVA,
    // or both phases without repeating the enrichment logic.
    const settings = buildPreviewSettings(req)
    const prepareUntestedIds = Array.isArray(req.session.data.prepareSkinTestUntested)
      ? req.session.data.prepareSkinTestUntested
      : []
    const prepareUntestedSet = new Set(prepareUntestedIds)
    // For the "Both" journey the vet has already split the herd into
    // SICCT and DIVA via /prepare-skin-test-assign – either auto (by
    // vaccination status) or manually. Use those assignments as the
    // canonical per-phase membership when present.
    const assignments = req.session.data.prepareSkinTestAssignments || null
    const hasAssignments = isBoth && assignments
      && Array.isArray(assignments.sicct) && Array.isArray(assignments.diva)
      && (assignments.sicct.length + assignments.diva.length > 0)
    function buildPreviewForPhase(phase) {
      const phaseAssignmentSet = hasAssignments
        ? new Set(assignments[phase] || [])
        : null
      const filtered = baseAnimals.filter(function (a) {
        if (prepareUntestedSet.has(a.officialId)) return false
        // For "Both" with assignments, the SICCT preview only shows
        // animals assigned to SICCT and the DIVA preview only shows
        // animals assigned to DIVA. Single-test journeys ignore this
        // and continue to use the not-tested filter alone.
        if (phaseAssignmentSet && !phaseAssignmentSet.has(a.officialId)) return false
        return true
      })
      const counts = {}
      filtered.forEach(function (a) {
        const last4 = String(a.officialId || '').slice(-4)
        counts[last4] = (counts[last4] || 0) + 1
      })
      const enriched = filtered.map(function (a, idx) {
        const last4 = String(a.officialId || '').slice(-4)
        // "Check the DOB" flag – animal sits in a window around the
        // 42-day minimum testing age (35–49 days). The vet keeps
        // these on the printed list but is prompted to "Check age"
        // before testing, with an underlined DOB cell as a visual cue.
        const daysOld = ageInMonthsFromDob(a.dob)
        const isUnderTestAge = typeof daysOld === 'number'
          && daysOld >= 35
          && daysOld <= 49
        // Below the minimum testing age outright, as opposed to near
        // enough to it to be worth checking. The same 42 days the
        // service tests against, so the sheet and the screen agree.
        const isTooYoung = typeof daysOld === 'number'
          && daysOld >= 0
          && daysOld < 42
        // "Check the TB Vax" flag – the last BCG vaccination was
        // around 9 months ago (8–10 months) so a booster is
        // approaching. Underlines the TB Vax cell on the list.
        const vaxMonths = monthsSinceVaxDate(a.vaccinationDate)
        const isVaxCheckDue = typeof vaxMonths === 'number'
          && vaxMonths >= 8
          && vaxMonths <= 10
        // "Frequent flyer" demo flag – an animal recently skin-tested
        // (e.g. a pre-movement test before it was bought in) that may
        // be within the 60-day minimum interval, so the vet should not
        // inject it again. Seeded on the first two animals of every
        // list so the marker is visible on Mill House and every other
        // farm. A real service would derive this from CTS test history.
        // Date is DD/MM/YYYY to match the DOB column and the rest of the
        // list. Test type shows which tuberculin was last used.
        // Frequent-flyer marker: spread a few recently-tested animals
        // through the list (deterministic from the ear tag) rather than
        // always clustering them at the top.
        let recentTestDate = a.recentTestDate || ''
        let recentTestType = a.recentTestType || ''
        if (!recentTestDate) {
          const recent = recentTestFor(a, phase, version === 'v1-4' || version === 'v1-5')
          if (recent) {
            recentTestDate = recent.date
            recentTestType = recent.type
          }
        }
        return Object.assign({}, a, {
          isDuplicate: counts[last4] > 1,
          isVaccinated: a.vaccinationStatus === 'Vaccinated',
          isUnderTestAge: isUnderTestAge,
          isTooYoung: isTooYoung,
          isVaxCheckDue: isVaxCheckDue,
          recentTestDate: recentTestDate,
          recentTestType: recentTestType,
          vaccinationDate: a.vaccinationDate || ''
        })
      })
      const rows = buildPreviewRows(enriched, settings.visibleColumns)
        .map(function (row, idx) {
          return Object.assign({}, row, {
            isDuplicate: enriched[idx].isDuplicate,
            isVaccinated: enriched[idx].isVaccinated,
            isUnderTestAge: enriched[idx].isUnderTestAge,
            isTooYoung: enriched[idx].isTooYoung,
            isVaxCheckDue: enriched[idx].isVaxCheckDue,
            recentTestDate: enriched[idx].recentTestDate,
            recentTestType: enriched[idx].recentTestType,
            vaccinationDate: enriched[idx].vaccinationDate,
            demo: populate
              ? buildDemo(enriched[idx].officialId, {
                  penMarks: version === 'v1-4', refOnlyForReactor: version === 'v1-4' || version === 'v1-5',
                  // The research herd fixes each animal's role; other
                  // herds still get the random spread.
                  role: enriched[idx].demoRole,
                  forceNotTested: V5_NOT_TESTED_ROLES[enriched[idx].demoRole] || null
                })
              : null
          })
        })
      // On a populated list, guarantee at least one of each demo feature
      // per list so testers always see them, forcing one where the random
      // spread produced none.
      // The forced-variety block below exists so a randomly generated
      // list always shows one of each feature. A herd with roles has
      // already been composed on purpose, and forcing extras on top of
      // it silently changed the counts - an eleventh reactor, three more
      // part tests, four not-tested reasons nobody asked for. So it only
      // runs where nothing has been composed.
      const hasRoles = enriched.some(function (a) { return !!a.demoRole })
      if (populate && rows.length && !hasRoles) {
        const n = rows.length
        const at = function (frac) { return Math.min(n - 1, Math.max(0, Math.floor(n * frac))) }
        // A few "not tested" animals per list (not found / deceased /
        // withdrawn for export / slaughter / by owner). One of each reason,
        // spread through the list and clear of the forced part-test (0.35)
        // and blurred-reactor (0.6) rows. Blank Pre/Post, short note.
        const notTestedReasons = ['not-found', 'deceased', 'export', 'slaughter', 'owner']
        const notTestedFracs = [0.08, 0.24, 0.48, 0.72, 0.9]
        notTestedReasons.forEach(function (reason, i) {
          const p = at(notTestedFracs[i])
          rows[p].demo = buildDemo(rows[p].officialId, { forceNotTested: reason, penMarks: version === 'v1-4', refOnlyForReactor: version === 'v1-4' || version === 'v1-5' })
        })
        // Part test (Day 2 not read) – a row with a Pre but blank Post.
        // Not-tested rows are blank throughout, so exclude them here.
        if (!rows.some(function (r) { return r.demo && r.demo.aPost === '' && !r.demo.notTested })) {
          const p = at(0.35); rows[p].demo = buildDemo(rows[p].officialId, { forceM2: true, penMarks: version === 'v1-4', refOnlyForReactor: version === 'v1-4' || version === 'v1-5' })
        }
        if (!rows.some(function (r) { return r.demo && /app-smudge-2/.test(r.demo.bPost) && />R</.test(r.demo.res) })) {
          const p = at(0.6); rows[p].demo = buildDemo(rows[p].officialId, { forceReactor: true, forceHeavyBlur: true, penMarks: version === 'v1-4', refOnlyForReactor: version === 'v1-4' || version === 'v1-5' })
        }
        if (!rows.some(function (r) { return r.isDuplicate })) {
          rows[at(0.15)].isDuplicate = true
        }
      }
      return { rows, count: enriched.length }
    }

    // Build the previews for whichever list(s) the filter panel has
    // currently selected. "Both" renders two stacked preview tables;
    // SICCT / DIVA render a single preview.
    let sicctPreview = null
    let divaPreview = null
    if (isBoth || prepareSkinTestPhase === 'sicct') {
      sicctPreview = buildPreviewForPhase('sicct')
    }
    if (isBoth || prepareSkinTestPhase === 'diva') {
      divaPreview = buildPreviewForPhase('diva')
    }

    // v1-2 PDF "Both" prepares TWO separate printed lists – one for
    // SICCT (unvaccinated cattle) and one for DIVA (vaccinated cattle).
    // There is no "either" option because the animal's vaccination
    // status determines which test it sits on. The vet picks which
    // list to print first on /v1-2/skin-test-list-order, then formats
    // and saves each list one at a time. The legacy combined-list
    // path is no longer built for v1-2; the rendering uses the
    // single-phase template branches with `prepareSkinTestPhase`
    // driving which test is shown.
    //
    // The ?both=1 query param overrides the per-phase view and
    // renders BOTH lists in one printable stack. Used by the final
    // confirmation page so a single Download button can print the
    // SICCT and DIVA lists together.
    const isCombinedBoth = false
    const showBothLists = isBoth
      && (version === 'v1-2' || isV13Plus(version))
      && req.query && req.query.both === '1'
    const combinedPreview = null

    // Single-preview variables kept for backwards compatibility with
    // the existing template. For "Both", default to the SICCT preview
    // so the existing SICCT table renders first and the DIVA table is
    // appended via the new divaPreview block.
    const previewRows = (combinedPreview && combinedPreview.rows)
      || (sicctPreview && sicctPreview.rows)
      || (divaPreview && divaPreview.rows)
      || []

    const downloadFormat = req.session.data.downloadFormat || 'pdf'

    // Format the "List created" stamp from the prepared-list record so
    // the printed sheet shows the same date as the prepared-lists row
    // on /v1-2/farm-tasks. Falls back to today's date (rendered client-
    // side in the template) if no preparedAt is stored, which keeps the
    // earlier behaviour for v1-0 / v1-1 and for sessions that bypass
    // the prepare flow entirely.
    let listCreatedFormatted = null
    if ((version === 'v1-2' || isV13Plus(version))) {
      const currentCph = req.session.data.herd && req.session.data.herd.cph
      const preparedRecords = Array.isArray(req.session.data.skinTestListPrepared)
        ? req.session.data.skinTestListPrepared
        : []
      const preparedRecord = currentCph && preparedRecords.find(function (r) {
        return r && r.cph === currentCph
      })
      if (preparedRecord && preparedRecord.preparedAt) {
        const d = new Date(preparedRecord.preparedAt)
        if (!isNaN(d.getTime())) {
          listCreatedFormatted = new Intl.DateTimeFormat('en-GB', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
          }).format(d)
        }
      }
    }

    // Populated list only: a handful of extra cattle (~7% of the list)
    // hand-written into the blank "Additional cattle" sheet.
    let extraCattle = []
    if (populate) {
      const _phaseRows = (sicctPreview && sicctPreview.rows) || (divaPreview && divaPreview.rows) || []
      const _n = _phaseRows.length || baseAnimals.length || 20
      const _sampleId = (baseAnimals[0] && baseAnimals[0].officialId) || 'UK246810000001'
      const _mark = String(_sampleId).replace(/^UK/i, '').slice(0, 6)
      const _count = (version === 'v1-4' || version === 'v1-5')
        ? 1
        : Math.min(18, Math.max(2, Math.round(_n * 0.07)))
      extraCattle = buildExtraCattle(_mark, _count)
    }

    // Return-visit list: this is the scoped list of animals still to test
    // from an open part test, reached via /part-test-list. Drives an inset
    // banner so the vet knows the sheet only covers the remaining animals.
    const returnVisit = isV13Plus(version)
      && !!(req.query && req.query.returnVisit)
      && Array.isArray(req.session.data.skinTestScopeIds)
      && req.session.data.skinTestScopeIds.length > 0
    const returnVisitCount = returnVisit ? req.session.data.skinTestScopeIds.length : 0

    res.render(`${version}/skin-test-list`, {
      previewRows,
      previewColumns: settings.visibleColumns,
      listCreatedFormatted,
      populate,
      returnVisit,
      returnVisitCount,
      extraCattle,
      previewAllColumns: skinTestListColumns,
      previewOptions: settings.previewOptions,
      emphasiseLastFive: settings.emphasiseLastFive,
      downloadFormat,
      previewTextSize: req.session.data.skinTestPreviewTextSize || 'standard',
      previewOrientation: req.session.data.skinTestPreviewOrientation || 'portrait',
      previewSpacing: req.session.data.skinTestPreviewSpacing || 'standard',
      prepareSkinTestType,
      prepareSkinTestPhase,
      listTestLabel: showBothLists
        ? 'SICCT and DIVA'
        : (prepareSkinTestPhase === 'diva' ? 'DIVA' : 'SICCT'),
      isBothJourney: isBoth,
      isCombinedBoth,
      showBothLists,
      // True when this is the second list in a v1-2 Both journey
      // (i.e. the other phase has already been confirmed). The inset
      // text drops the "you'll format the other list next" sentence
      // when this is true.
      isSecondList: isBoth
        && (version === 'v1-2' || isV13Plus(version))
        && !showBothLists
        && (req.session.data.prepareSkinTestListConfirmedPhases || [])
             .indexOf(prepareSkinTestPhase === 'sicct' ? 'diva' : 'sicct') !== -1,
      // For v1-1 "Both", show the step indicator so the vet sees there's
      // a second list still to format after this one. v1-2 drives the
      // two-step flow via the /skin-test-list-order picker + per-test
      // confirmed page, so the step text isn't shown for v1-2 Both.
      bothStepText: isBoth && !isCombinedBoth && (version !== 'v1-2' && !isV13Plus(version))
        ? (prepareSkinTestPhase === 'sicct' ? 'Step 1 of 2' : 'Step 2 of 2')
        : null,
      sicctPreviewRows: sicctPreview && sicctPreview.rows,
      sicctPreviewCount: sicctPreview && sicctPreview.count,
      divaPreviewRows: divaPreview && divaPreview.rows,
      divaPreviewCount: divaPreview && divaPreview.count,
      combinedPreviewRows: combinedPreview && combinedPreview.rows,
      combinedPreviewCount: combinedPreview && combinedPreview.count,
      // v1-2 paginates the preview so each "page" represents a single
      // A4 sheet. The vet picks the list "look" (Easy to read / Compact)
      // on the disclosure panel; that value drives both pagination and
      // visual density. Default to Easy to read (20 per page) if
      // nothing has been chosen yet.
      pageSize: req.session.data.skinTestCattlePerPage || 20,
      cattlePerPage: req.session.data.skinTestCattlePerPage || 20,
      listLook: req.session.data.skinTestListLook || 'easy',
      sortByLabel: (function () {
        const s = req.session.data.skinTestSortBy || 'Ear-tag number (last 5 digits)'
        if (s === 'Age') return 'age'
        if (s === 'Sex') return 'sex'
        return 'Ear tag'
      })(),
      currentPage: Math.max(1, parseInt((req.query && req.query.page) || '1', 10) || 1),
      // ?print=1 triggers window.print() once the page has loaded.
      // When that flag is set we render every preview page stacked on
      // the same screen, with CSS page-break-after between sheets, so
      // the printed output is the complete list instead of just the
      // current paginated page. Be lenient about how the flag arrives
      // – any truthy ?print value, or a ?printAll flag, counts.
      printAll: !!(req.query && (req.query.print || req.query.printAll))
    })
  })

  router.post(`/${version}/skin-test-list`, function (req, res) {
    // v1-2: only two settings are user-facing now – the list "look"
    // (Easy to read / Compact) and the sort key. All columns are
    // always shown and the last-4 ear-tag emphasis is always on.
    // listLook drives both the page size and the visual density:
    //   easy    → 20 per page, standard text/spacing
    //   compact → 40 per page, small text + tight spacing
    const listLook = req.body.listLook === 'compact' ? 'compact' : 'easy'
    const cattlePerPage = listLook === 'compact' ? 40 : 20
    let textSize = 'standard'
    let spacing = 'standard'
    if (listLook === 'compact') { textSize = 'small'; spacing = 'tight' }

    // Sort key – restricted to the three options on the new "Change
    // list settings" panel. Anything else falls back to the default.
    const allowedSorts = [
      'Ear-tag number (last 5 digits)',
      'Age',
      'Sex'
    ]
    const submittedSort = req.body.sortBy
    const sortBy = allowedSorts.indexOf(submittedSort) !== -1
      ? submittedSort
      : 'Ear-tag number (last 5 digits)'

    req.session.data.skinTestListLook = listLook
    req.session.data.skinTestCattlePerPage = cattlePerPage
    req.session.data.skinTestPreviewTextSize = textSize
    req.session.data.skinTestPreviewSpacing = spacing
    req.session.data.skinTestPreviewOrientation = 'portrait'
    req.session.data.downloadFormat = 'pdf'
    req.session.data.skinTestSortBy = sortBy
    req.session.data.skinTestSortDirection = 'asc'
    // All columns + last-4 emphasis are always on for the new design.
    req.session.data.skinTestPreviewOptions = ['show-last-five', ...skinTestListColumns]

    res.redirect(`/${version}/skin-test-list`)
  })

  router.get(`/${version}/skin-test-list/reset`, function (req, res) {
    req.session.data.skinTestListLook = 'easy'
    req.session.data.skinTestCattlePerPage = 20
    req.session.data.skinTestPreviewOptions = ['show-last-five', ...skinTestListColumns]
    req.session.data.skinTestSortBy = 'Ear-tag number (last 5 digits)'
    req.session.data.skinTestSortDirection = 'asc'
    req.session.data.downloadFormat = 'pdf'
    req.session.data.skinTestPreviewTextSize = 'standard'
    req.session.data.skinTestPreviewOrientation = 'portrait'
    req.session.data.skinTestPreviewSpacing = 'standard'
    res.redirect(`/${version}/skin-test-list`)
  })

  // Confirmation / success page for the prepare-skin-test-list journey.
  // For "Both", this is shown twice – once for SICCT, once for DIVA –
  // with a "Continue to the DIVA list" button after the first step.
  router.get(`/${version}/skin-test-list-confirmed`, function (req, res) {
    const prepareSkinTestType = req.session.data.prepareSkinTestType || 'SICCT'
    const prepareSkinTestPhase = req.session.data.prepareSkinTestPhase
      || (prepareSkinTestType === 'DIVA' ? 'diva' : 'sicct')
    const isBoth = prepareSkinTestType === 'Both'
    // v1-2 Both now runs the SICCT and DIVA lists as two separate
    // print steps (driven by the picker on /skin-test-list-order), so
    // it no longer combines them. The legacy v1-1 path keeps the
    // SICCT-then-DIVA flow unchanged.
    const isCombinedBoth = false
    const listTestLabel = prepareSkinTestPhase === 'diva' ? 'DIVA' : 'SICCT'

    // Track which lists the vet has confirmed in this Both journey so
    // we know whether to offer "Continue to <other> list" or to
    // declare the journey done. The first time the vet hits this
    // page after the picker, only the firstOrder phase will be in
    // the list. After the second confirmation both will be present.
    if (isBoth) {
      const confirmed = Array.isArray(req.session.data.prepareSkinTestListConfirmedPhases)
        ? req.session.data.prepareSkinTestListConfirmedPhases.slice()
        : []
      if (confirmed.indexOf(prepareSkinTestPhase) === -1) {
        confirmed.push(prepareSkinTestPhase)
      }
      req.session.data.prepareSkinTestListConfirmedPhases = confirmed
    }

    const firstOrder = req.session.data.prepareSkinTestListFirstOrder
    const otherPhase = prepareSkinTestPhase === 'sicct' ? 'diva' : 'sicct'
    // Show the "Continue to <other> list" panel when this is the
    // first of two confirmations (Both, vet just confirmed the
    // firstOrder phase, the other phase isn't in the confirmed list
    // yet). For v1-1 the original SICCT-first assumption is the same
    // as firstOrder === 'sicct'.
    const confirmedSoFar = Array.isArray(req.session.data.prepareSkinTestListConfirmedPhases)
      ? req.session.data.prepareSkinTestListConfirmedPhases
      : []
    const bothHasNextStep = isBoth
      && (version === 'v1-2' || isV13Plus(version))
      && firstOrder
      && prepareSkinTestPhase === firstOrder
      && confirmedSoFar.indexOf(otherPhase) === -1
      ? true
      : ((version !== 'v1-2' && !isV13Plus(version)) && isBoth && prepareSkinTestPhase === 'sicct')

    // Record (or update) the prepared list against the current farm
    // so the dashboard's "Work in progress" can offer the vet a way
    // back to view / edit / reprint the list, or report on the same
    // cattle. We only mark "Both" as fully prepared once both list
    // steps have been confirmed (ie. there's no next step left).
    const herd = req.session.data.herd
    const cph = herd && herd.cph
    if (cph) {
      const types = isBoth ? ['SICCT', 'DIVA'] : [listTestLabel]
      const existing = Array.isArray(req.session.data.skinTestListPrepared)
        ? req.session.data.skinTestListPrepared.filter(function (r) { return r && r.cph !== cph })
        : []
      if (!bothHasNextStep) {
        existing.push({ cph, types, preparedAt: new Date().toISOString() })
      }
      req.session.data.skinTestListPrepared = existing
    }

    res.render(`${version}/skin-test-list-confirmed`, {
      prepareSkinTestType,
      prepareSkinTestPhase,
      listTestLabel,
      isBothJourney: isBoth,
      isCombinedBoth,
      bothHasNextStep
    })
  })

  // Advance to the second list in a Both journey. v1-1 always goes
  // SICCT → DIVA. v1-2 switches to whichever phase the vet didn't
  // pick on /skin-test-list-order. Either way the format settings
  // reset so the second list starts from the defaults.
  router.post(`/${version}/prepare-skin-test-next`, function (req, res) {
    const data = req.session.data
    const isBoth = data.prepareSkinTestType === 'Both'

    if (isBoth && (version === 'v1-2' || isV13Plus(version))) {
      const firstOrder = data.prepareSkinTestListFirstOrder || 'sicct'
      const otherPhase = firstOrder === 'sicct' ? 'diva' : 'sicct'
      if (data.prepareSkinTestPhase === firstOrder) {
        data.prepareSkinTestPhase = otherPhase
        data.skinTestPreviewOptions = ['show-last-five', ...skinTestListColumns]
        data.skinTestSortBy = 'Ear-tag number (last 5 digits)'
        data.skinTestSortDirection = 'asc'
        data.downloadFormat = 'pdf'
        data.skinTestPreviewTextSize = 'standard'
        data.skinTestPreviewOrientation = 'portrait'
        data.skinTestPreviewSpacing = 'standard'
        return res.redirect(`/${version}/skin-test-list`)
      }
    }

    // v1-1 (legacy) – always SICCT → DIVA on the first confirmation.
    if (isBoth && data.prepareSkinTestPhase === 'sicct') {
      data.prepareSkinTestPhase = 'diva'
      data.skinTestPreviewOptions = ['show-last-five', ...skinTestListColumns]
      data.skinTestSortBy = 'Ear-tag number (last 5 digits)'
      data.skinTestSortDirection = 'asc'
      data.downloadFormat = 'pdf'
      data.skinTestPreviewTextSize = 'standard'
      data.skinTestPreviewOrientation = 'portrait'
      data.skinTestPreviewSpacing = 'standard'
      return res.redirect(`/${version}/skin-test-list`)
    }

    res.redirect(`/${version}/skin-test-list-confirmed`)
  })

  // Journey 2 – Report skin test results --------------------------------------

  router.get(`/${version}/skin-test-date`, function (req, res) {
    res.render(`${version}/skin-test-date`)
  })

  router.post(`/${version}/skin-test-date`, function (req, res) {
    // Day 1 date – captured on every version. No validation here;
    // blanks are allowed through so the vet can iterate on the page.
    req.session.data.skinTestDay1Day = (req.body['skinTestDay1-day'] || '').trim()
    req.session.data.skinTestDay1Month = (req.body['skinTestDay1-month'] || '').trim()
    req.session.data.skinTestDay1Year = (req.body['skinTestDay1-year'] || '').trim()

    if ((version === 'v1-2' || isV13Plus(version))) {
      // v1-2 captures the Day 1 start time inline and either calculates
      // Day 2 from "Day 1 + 72 hours" (default) or asks the vet for a
      // separate Day 2 date/time when they tick "test taken over more
      // than one day". The Day 2 page is no longer used on v1-2.
      req.session.data.skinTestDay1StartTimeHour = (req.body['skinTestDay1StartTime-hour'] || '').trim()
      req.session.data.skinTestDay1StartTimeMinute = (req.body['skinTestDay1StartTime-minute'] || '').trim()
      req.session.data.skinTestDay1StartTimeAmpm = (req.body['skinTestDay1StartTime-ampm'] || 'AM').trim()

      const multiDay = Array.isArray(req.body.skinTestMultiDay)
        ? req.body.skinTestMultiDay
        : [req.body.skinTestMultiDay].filter(Boolean)
      const isMultiDay = multiDay.includes('yes')
      req.session.data.skinTestMultiDay = isMultiDay ? 'yes' : null

      if (isMultiDay) {
        // Vet has provided explicit Day 2 details.
        req.session.data.skinTestDay2Day = (req.body['skinTestDay2-day'] || '').trim()
        req.session.data.skinTestDay2Month = (req.body['skinTestDay2-month'] || '').trim()
        req.session.data.skinTestDay2Year = (req.body['skinTestDay2-year'] || '').trim()
        req.session.data.skinTestDay2StartTimeHour = (req.body['skinTestDay2StartTime-hour'] || '').trim()
        req.session.data.skinTestDay2StartTimeMinute = (req.body['skinTestDay2StartTime-minute'] || '').trim()
        req.session.data.skinTestDay2StartTimeAmpm = (req.body['skinTestDay2StartTime-ampm'] || 'AM').trim()
        req.session.data.skinTestDay2Calculated = null
      } else {
        // Single-day test – derive Day 2 as 72 hours after Day 1 so the
        // vet doesn't have to enter it twice. The confirmation screen
        // shows a "calculated from Day 1" note alongside the value.
        const day2 = addHoursToDateTimeParts(
          req.session.data.skinTestDay1Day,
          req.session.data.skinTestDay1Month,
          req.session.data.skinTestDay1Year,
          req.session.data.skinTestDay1StartTimeHour,
          req.session.data.skinTestDay1StartTimeMinute,
          req.session.data.skinTestDay1StartTimeAmpm,
          72
        )
        if (day2) {
          req.session.data.skinTestDay2Day = day2.day
          req.session.data.skinTestDay2Month = day2.month
          req.session.data.skinTestDay2Year = day2.year
          req.session.data.skinTestDay2StartTimeHour = day2.hour
          req.session.data.skinTestDay2StartTimeMinute = day2.minute
          req.session.data.skinTestDay2StartTimeAmpm = day2.ampm
          req.session.data.skinTestDay2Calculated = 'yes'
        } else {
          // Day 1 incomplete – clear any stale Day 2 derived state so
          // the confirmation page doesn't show a misleading value.
          req.session.data.skinTestDay2Day = null
          req.session.data.skinTestDay2Month = null
          req.session.data.skinTestDay2Year = null
          req.session.data.skinTestDay2StartTimeHour = null
          req.session.data.skinTestDay2StartTimeMinute = null
          req.session.data.skinTestDay2StartTimeAmpm = null
          req.session.data.skinTestDay2Calculated = null
        }
      }

      return res.redirect(`/${version}/skin-test-type`)
    }

    // v1-0 / v1-1 keep the original two-page flow – Day 2 is captured
    // on the following screen.
    const day1Multi = Array.isArray(req.body.skinTestDay1OverMultipleDays)
      ? req.body.skinTestDay1OverMultipleDays
      : [req.body.skinTestDay1OverMultipleDays].filter(Boolean)
    req.session.data.skinTestDay1OverMultipleDays = day1Multi.includes('yes') ? 'yes' : null

    res.redirect(`/${version}/skin-test-date-day-2`)
  })

  router.get(`/${version}/skin-test-date-day-2`, function (req, res) {
    // v1-2 no longer has a separate Day 2 page – Day 2 is either
    // calculated from Day 1 + 72 hours or captured inline via the
    // "multi-day" checkbox on /skin-test-date. Redirect any stray
    // links back there.
    if ((version === 'v1-2' || isV13Plus(version))) {
      return res.redirect(`/${version}/skin-test-date`)
    }
    res.render(`${version}/skin-test-date-day-2`)
  })

  router.post(`/${version}/skin-test-date-day-2`, function (req, res) {
    if ((version === 'v1-2' || isV13Plus(version))) {
      return res.redirect(`/${version}/skin-test-date`)
    }
    req.session.data.skinTestDay2Day = (req.body['skinTestDay2-day'] || '').trim()
    req.session.data.skinTestDay2Month = (req.body['skinTestDay2-month'] || '').trim()
    req.session.data.skinTestDay2Year = (req.body['skinTestDay2-year'] || '').trim()

    const day2Multi = Array.isArray(req.body.skinTestDay2OverMultipleDays)
      ? req.body.skinTestDay2OverMultipleDays
      : [req.body.skinTestDay2OverMultipleDays].filter(Boolean)
    req.session.data.skinTestDay2OverMultipleDays = day2Multi.includes('yes') ? 'yes' : null

    res.redirect(`/${version}/skin-test-type`)
  })

  router.get(`/${version}/skin-test-type`, function (req, res) {
    // v1-2 and v1-3 both auto-derive prepareSkinTestType from the
    // herd's vaccination status when the vet jumped into the report
    // flow without preparing a list first.
    if ((version === 'v1-2' || isV13Plus(version))) {
      if (!req.session.data.prepareSkinTestType) {
        autoSetupSkinTestForV12(req, version)
      }
      const preparedType = req.session.data.prepareSkinTestType
      const completed = Array.isArray(req.session.data.skinTestCompletedTests)
        ? req.session.data.skinTestCompletedTests
        : []
      req.session.data.skinTestCompletedTests = completed

      // v1-3: always render the "Which test did you do?" checkbox
      // question. The vet may have done a different combination than
      // what was prepared (e.g. only did SICCT today, even though the
      // CPH had both prepared), so we never auto-skip on v1-3 and let
      // them choose. Per-phase pointers are reset so a re-visit starts
      // fresh.
      if (isV13Plus(version)) {
        req.session.data.currentSkinTestIndex = 0
        req.session.data.currentDivaIndex = 0
        req.session.data.completedSkinTestPhases = []
        req.session.data.skinTestReactors = null
        req.session.data.anyReactors = null
        return res.render(`${version}/skin-test-type`)
      }

      // v1-2: keep the original auto-skip behaviour – single-test
      // CPHs jump straight to batch-details and only the Both case
      // renders the "first test" picker.
      if (preparedType === 'SICCT' || preparedType === 'DIVA') {
        req.session.data.skinTestType = preparedType
        req.session.data.currentSkinTest = preparedType.toLowerCase()
        req.session.data.skinTestFirstOrder = preparedType.toLowerCase()
        return res.redirect(`/${version}/skin-test-batch-details/${preparedType.toLowerCase()}`)
      }

      if (preparedType === 'Both') {
        req.session.data.skinTestType = 'Both'
        // Reset per-phase pointers so the picker always starts fresh.
        req.session.data.currentSkinTestIndex = 0
        req.session.data.currentDivaIndex = 0
        req.session.data.completedSkinTestPhases = []
        req.session.data.skinTestReactors = null
        req.session.data.anyReactors = null
        return res.render(`${version}/skin-test-type`)
      }
    }
    res.render(`${version}/skin-test-type`)
  })

  router.post(`/${version}/skin-test-type`, function (req, res) {
    // v1-3: the page asks "Which test did you do?" with a single
    // SICCT / DIVA / Both radio. SICCT or DIVA → straight to that test's
    // batch-details page; Both → on to /skin-test-record-first so the
    // vet can pick which to record first.
    if (isV13Plus(version)) {
      const choice = (req.body.testType || '').trim()

      if (choice !== 'SICCT' && choice !== 'DIVA' && choice !== 'Both') {
        return res.render(`${version}/skin-test-type`, {
          errors: { testType: { text: 'Select which test you did' } },
          errorSummary: {
            titleText: 'There is a problem',
            errorList: [{ text: 'Select which test you did', href: '#testType' }]
          }
        })
      }

      const hasSicct = choice === 'SICCT' || choice === 'Both'
      const hasDiva = choice === 'DIVA' || choice === 'Both'
      // Keep skinTestTests populated as an array for the downstream
      // measurement / summary screens that still read it.
      req.session.data.skinTestTests = choice === 'Both' ? ['SICCT', 'DIVA'] : [choice]
      req.session.data.skinTestCompletedTests = []

      if (hasSicct && hasDiva) {
        req.session.data.skinTestType = 'Both'
        // Clear any stale first-order from a previous visit so the
        // picker on the next page starts unselected.
        req.session.data.skinTestFirstOrder = null
        return res.redirect(`/${version}/skin-test-record-first`)
      }

      const single = hasSicct ? 'sicct' : 'diva'
      req.session.data.skinTestType = single.toUpperCase()
      req.session.data.skinTestFirstOrder = single
      req.session.data.currentSkinTest = single
      return res.redirect(`/${version}/skin-test-batch-details/${single}`)
    }

    // v1-2: only the "first test" picker for Both CPHs lands here.
    // POST stores the choice and sends the vet to the batch-details
    // page for whichever test they picked first.
    if (version === 'v1-2') {
      const firstOrder = req.body.skinTestFirstOrder === 'diva'
        ? 'diva'
        : (req.body.skinTestFirstOrder === 'sicct' ? 'sicct' : null)
      if (!firstOrder) {
        return res.render(`${version}/skin-test-type`, {
          errors: { skinTestFirstOrder: { text: 'Select which test you want to record first' } },
          errorSummary: {
            titleText: 'There is a problem',
            errorList: [{ text: 'Select which test you want to record first', href: '#skinTestFirstOrder' }]
          }
        })
      }
      req.session.data.skinTestType = 'Both'
      req.session.data.skinTestFirstOrder = firstOrder
      req.session.data.currentSkinTest = firstOrder
      req.session.data.skinTestCompletedTests = []
      return res.redirect(`/${version}/skin-test-batch-details/${firstOrder}`)
    }

    // ----- Legacy v1-0 / v1-1 path: the checkbox-based picker -----
    // Tests: a checkbox group with values "SICCT" and "DIVA". The vet
    // can pick one or both. The Prototype Kit injects the "_unchecked"
    // placeholder for empty submissions, which we strip out.
    const submittedTests = Array.isArray(req.body.tests)
      ? req.body.tests
      : (req.body.tests ? [req.body.tests] : [])
    const tests = submittedTests.filter(function (t) {
      return t && t !== '_unchecked'
    })

    const sicctBatchesRaw = Array.isArray(req.body.sicctBatches)
      ? req.body.sicctBatches
      : (req.body.sicctBatches !== undefined ? [req.body.sicctBatches] : [])
    const divaBatchesRaw = Array.isArray(req.body.divaBatches)
      ? req.body.divaBatches
      : (req.body.divaBatches !== undefined ? [req.body.divaBatches] : [])

    req.session.data.skinTestTests = tests
    req.session.data.skinTestSicctBatches = sicctBatchesRaw
    req.session.data.skinTestDivaBatches = divaBatchesRaw

    if (req.body.addBatch === 'sicct') {
      req.session.data.skinTestSicctBatches = sicctBatchesRaw.concat([''])
      if (tests.indexOf('SICCT') === -1) {
        req.session.data.skinTestTests = tests.concat(['SICCT'])
      }
      return res.redirect(`/${version}/skin-test-type`)
    }
    if (req.body.addBatch === 'diva') {
      req.session.data.skinTestDivaBatches = divaBatchesRaw.concat([''])
      if (tests.indexOf('DIVA') === -1) {
        req.session.data.skinTestTests = tests.concat(['DIVA'])
      }
      return res.redirect(`/${version}/skin-test-type`)
    }

    if (!tests.length) {
      return res.render(`${version}/skin-test-type`, {
        errors: { tests: { text: 'Select which test you did' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select which test you did', href: '#tests' }]
        }
      })
    }

    const hasSicct = tests.indexOf('SICCT') !== -1
    const hasDiva = tests.indexOf('DIVA') !== -1
    const skinTestType = (hasSicct && hasDiva)
      ? 'Both'
      : (hasDiva ? 'DIVA' : 'SICCT')
    req.session.data.skinTestType = skinTestType

    req.session.data.skinTestSicctBatches = hasSicct
      ? sicctBatchesRaw.map(function (b) { return (b || '').trim() }).filter(Boolean)
      : []
    req.session.data.skinTestDivaBatches = hasDiva
      ? divaBatchesRaw.map(function (b) { return (b || '').trim() }).filter(Boolean)
      : []

    req.session.data.currentSkinTestIndex = 0
    req.session.data.currentDivaIndex = 0
    req.session.data.completedSkinTestPhases = []
    req.session.data.skinTestFirstOrder = null
    req.session.data.skinTestReactors = null
    req.session.data.anyReactors = null
    req.session.data.skinTestUntested = null
    req.session.data.skinTestUntestedReasons = null

    if (skinTestType === 'Both') {
      return res.redirect(`/${version}/skin-test-both-order`)
    }

    res.redirect(`/${version}/skin-test-reactors-any`)
  })

  // --- v1-3: "Which test do you want to record first?" -----------------
  // Only reached on v1-3 when the vet said they did BOTH tests on
  // /v1-3/skin-test-type. Single-test journeys skip this page; their
  // POST handler redirects straight to batch-details. Stray visits
  // (no Both selection) are bounced back to the checkbox page.
  router.get(`/${version}/skin-test-record-first`, function (req, res) {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/skin-test-type`)
    }
    if (req.session.data.skinTestType !== 'Both') {
      return res.redirect(`/${version}/skin-test-type`)
    }
    res.render(`${version}/skin-test-record-first`)
  })

  router.post(`/${version}/skin-test-record-first`, function (req, res) {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/skin-test-type`)
    }
    const firstOrder = req.body.skinTestFirstOrder === 'diva'
      ? 'diva'
      : (req.body.skinTestFirstOrder === 'sicct' ? 'sicct' : null)
    if (!firstOrder) {
      return res.render(`${version}/skin-test-record-first`, {
        errors: { skinTestFirstOrder: { text: 'Select which test you want to record first' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select which test you want to record first', href: '#skinTestFirstOrder' }]
        }
      })
    }
    req.session.data.skinTestFirstOrder = firstOrder
    req.session.data.currentSkinTest = firstOrder
    res.redirect(`/${version}/skin-test-batch-details/${firstOrder}`)
  })

  // --- Per-test batch details (v1-2 only) -------------------------------
  // Two-page sub-flow: the vet first confirms the batch number and
  // vaccine expiry date for the active test, then the diluent batch
  // number and diluent date on the next page. Both pages persist into
  // the same per-test session object so downstream code can read the
  // full set in one place.
  //
  //   skinTestBatchDetails.<test> = {
  //     batch, vaccineExpiryDay, vaccineExpiryMonth, vaccineExpiryYear,
  //     diluentBatch, diluentDateDay, diluentDateMonth, diluentDateYear
  //   }
  //
  // Values come straight off the printed list, so neither page does
  // any validation – the vet is just confirming what's already on
  // paper and a blank submission is allowed.
  function ensureBatchDetails (req, test) {
    req.session.data.skinTestBatchDetails = req.session.data.skinTestBatchDetails || {}
    req.session.data.skinTestBatchDetails[test] = req.session.data.skinTestBatchDetails[test] || {}
    return req.session.data.skinTestBatchDetails[test]
  }

  function formatBatchDetailsForView (stored) {
    const s = stored || {}
    return {
      batch: s.batch || '',
      vaccineExpiryDay: s.vaccineExpiryDay || '',
      vaccineExpiryMonth: s.vaccineExpiryMonth || '',
      vaccineExpiryYear: s.vaccineExpiryYear || '',
      diluentBatch: s.diluentBatch || '',
      diluentDateDay: s.diluentDateDay || '',
      diluentDateMonth: s.diluentDateMonth || '',
      diluentDateYear: s.diluentDateYear || ''
    }
  }

  router.get(`/${version}/skin-test-batch-details/:test`, function (req, res) {
    const test = req.params.test === 'diva' ? 'diva' : 'sicct'
    const testLabel = test === 'diva' ? 'DIVA' : 'SICCT'
    const stored = ensureBatchDetails(req, test)
    // Back link:
    //  - Second test of a Both journey → previous test's per-test
    //    confirm page (so the vet can revisit the first test).
    //  - First test of a Both journey → the "which to record first"
    //    picker on v1-3 (a separate page), or the combined
    //    skin-test-type page on earlier versions.
    //  - Single-test CPH on v1-3 → the new "Which test did you do?"
    //    checkbox page; on earlier versions → skin-test-date.
    const isBoth = req.session.data.skinTestType === 'Both'
    const firstOrder = req.session.data.skinTestFirstOrder
    const otherTest = test === 'sicct' ? 'diva' : 'sicct'
    let backHref
    if (isBoth && firstOrder !== test) {
      backHref = `/${version}/skin-test-confirm-test/${otherTest}`
    } else if (isBoth) {
      backHref = isV13Plus(version)
        ? `/${version}/skin-test-record-first`
        : `/${version}/skin-test-type`
    } else {
      backHref = isV13Plus(version)
        ? `/${version}/skin-test-type`
        : `/${version}/skin-test-date`
    }

    res.render(`${version}/skin-test-batch-details`, {
      test: test,
      testLabel: testLabel,
      backHref: backHref,
      formValues: formatBatchDetailsForView(stored)
    })
  })

  router.post(`/${version}/skin-test-batch-details/:test`, function (req, res) {
    const test = req.params.test === 'diva' ? 'diva' : 'sicct'
    const stored = ensureBatchDetails(req, test)

    stored.batch = (req.body.batch || '').trim()
    stored.vaccineExpiryDay = (req.body.vaccineExpiryDay || '').trim()
    stored.vaccineExpiryMonth = (req.body.vaccineExpiryMonth || '').trim()
    stored.vaccineExpiryYear = (req.body.vaccineExpiryYear || '').trim()

    // Mirror the trimmed batch onto the legacy per-test session keys
    // the existing measurement / confirmation templates still read
    // (skinTestSicctBatches / skinTestDivaBatches). They expect an
    // array, so a single-value batch becomes a 1-element list (empty
    // batch becomes an empty list).
    const batchList = stored.batch ? [stored.batch] : []
    if (test === 'sicct') {
      req.session.data.skinTestSicctBatches = batchList
    } else {
      req.session.data.skinTestDivaBatches = batchList
    }

    req.session.data.currentSkinTest = test
    // v1-3 drops the diluent-details step from the reporting flow.
    // The vet goes straight from batch-details to reactors-any; the
    // diluent fields are no longer captured during reporting.
    if (isV13Plus(version)) {
      return res.redirect(`/${version}/skin-test-reactors-any`)
    }
    res.redirect(`/${version}/skin-test-diluent-details/${test}`)
  })

  router.get(`/${version}/skin-test-diluent-details/:test`, function (req, res) {
    // v1-3 has retired this step. Defensively bounce anyone who lands
    // here (e.g. from a bookmark or a stale Change link) onto the
    // next page in the new flow.
    if (isV13Plus(version)) {
      return res.redirect(`/${version}/skin-test-reactors-any`)
    }
    const test = req.params.test === 'diva' ? 'diva' : 'sicct'
    const testLabel = test === 'diva' ? 'DIVA' : 'SICCT'
    const stored = ensureBatchDetails(req, test)

    res.render(`${version}/skin-test-diluent-details`, {
      test: test,
      testLabel: testLabel,
      formValues: formatBatchDetailsForView(stored)
    })
  })

  router.post(`/${version}/skin-test-diluent-details/:test`, function (req, res) {
    const test = req.params.test === 'diva' ? 'diva' : 'sicct'
    const stored = ensureBatchDetails(req, test)

    stored.diluentBatch = (req.body.diluentBatch || '').trim()
    stored.diluentDateDay = (req.body.diluentDateDay || '').trim()
    stored.diluentDateMonth = (req.body.diluentDateMonth || '').trim()
    stored.diluentDateYear = (req.body.diluentDateYear || '').trim()

    req.session.data.currentSkinTest = test
    res.redirect(`/${version}/skin-test-reactors-any`)
  })

  // --- Per-test confirmation page (v1-2) --------------------------------
  // Shows what the vet entered for the active test (batches, reactor
  // count) and gives them a single Continue action. On submit the
  // route decides where to go next via nextRouteAfterCurrentTest: if
  // the Both journey still has the other test outstanding, the vet
  // is sent to its batch-details page; otherwise we continue on to
  // the all-tested gate.
  function formatDmyDisplay (d, m, y) {
    if (!d && !m && !y) return ''
    return [d, m, y].filter(Boolean).join('/')
  }

  router.get(`/${version}/skin-test-confirm-test/:test`, function (req, res) {
    const test = req.params.test === 'diva' ? 'diva' : 'sicct'
    const testLabel = test === 'diva' ? 'DIVA' : 'SICCT'
    // Keep the per-test sub-flow scoped to this test so the "Change" link on
    // the Reacted row opens the reactor picker for the right test (SICCT or
    // DIVA) rather than the whole-herd measurement table.
    req.session.data.currentSkinTest = test
    const batchDetails = (req.session.data.skinTestBatchDetails || {})[test] || {}

    const vaccineExpiryDisplay = formatDmyDisplay(
      batchDetails.vaccineExpiryDay,
      batchDetails.vaccineExpiryMonth,
      batchDetails.vaccineExpiryYear
    )
    const diluentDateDisplay = formatDmyDisplay(
      batchDetails.diluentDateDay,
      batchDetails.diluentDateMonth,
      batchDetails.diluentDateYear
    )

    const reactorIds = getReactorsForPhase(req, test)
    // Build reactor entries with the officialId so the template can
    // render the same bulleted ear-tag list as the final
    // /v1-2/skin-test-confirmation page.
    const reactorEntries = reactorIds.map(function (id) {
      return { officialId: id }
    })

    // Continue button label changes depending on whether there's
    // another test to run. If the Both journey still has the other
    // test outstanding, the vet's next step is that test, so the
    // button reads "Continue to <other>". Otherwise it just says
    // "Continue".
    const isBoth = req.session.data.skinTestType === 'Both'
    const otherTest = test === 'sicct' ? 'diva' : 'sicct'
    const completed = Array.isArray(req.session.data.skinTestCompletedTests)
      ? req.session.data.skinTestCompletedTests
      : []
    const otherStillOutstanding = isBoth && completed.indexOf(otherTest) === -1
    const continueButtonLabel = otherStillOutstanding
      ? `Continue to ${otherTest === 'diva' ? 'DIVA' : 'SICCT'}`
      : 'Continue'

    // Back link points to wherever the vet came from – the
    // measurements table when reactors were recorded, otherwise the
    // reactors-any gate (since the vet answered "no" there and
    // skipped both reactors / measurements).
    const backHref = reactorIds.length > 0
      ? `/${version}/${testTablePath}`
      : `/${version}/skin-test-reactors-any`

    res.render(`${version}/skin-test-confirm-test`, {
      test: test,
      testLabel: testLabel,
      batchDetails: batchDetails,
      vaccineExpiryDisplay: vaccineExpiryDisplay,
      diluentDateDisplay: diluentDateDisplay,
      reactorEntries: reactorEntries,
      reactorCount: reactorIds.length,
      continueButtonLabel: continueButtonLabel,
      backHref: backHref
    })
  })

  router.post(`/${version}/skin-test-confirm-test/:test`, function (req, res) {
    const test = req.params.test === 'diva' ? 'diva' : 'sicct'
    req.session.data.currentSkinTest = test
    const nextRoute = nextRouteAfterCurrentTest(req, version)
    res.redirect(nextRoute)
  })

  // --- Reactor picker ---------------------------------------------------
  // The vet ticks which animals reacted (or ticks "No cattle reacted"
  // to skip the measurement loop entirely). Only reactors go through
  // the detailed SICCT / DIVA screens.
  function getReportingAnimalsWithFlags(req) {
    // When a list has already been prepared for this farm the reactor
    // picker mirrors the prepared list's sort so the vet sees cattle
    // in the same order they were printed in. Otherwise it falls
    // back to the mark-untested page's sort, then to the default.
    const cph = req.session.data.herd && req.session.data.herd.cph
    const preparedRecords = Array.isArray(req.session.data.skinTestListPrepared)
      ? req.session.data.skinTestListPrepared
      : []
    const hasPreparedList = !!cph && preparedRecords.some(function (r) {
      return r && r.cph === cph
    })
    const sortBy = hasPreparedList
      ? (req.session.data.skinTestSortBy
        || req.session.data.prepareSkinTestUntestedSortBy
        || 'Ear-tag number (last 5 digits)')
      : (req.session.data.prepareSkinTestUntestedSortBy
        || 'Ear-tag number (last 5 digits)')
    const sortDirection = hasPreparedList
      ? (req.session.data.skinTestSortDirection
        || req.session.data.prepareSkinTestUntestedSortDirection
        || 'asc')
      : (req.session.data.prepareSkinTestUntestedSortDirection || 'asc')
    // getSkinTestAnimals has already applied the printed list's own
    // ordering for the default ear-tag sort (boxed last 4, then last 5 -
    // see the note there). Re-sorting here with the plain last-5
    // comparison throws that away, so for the V5 variants, whose whole
    // point is that a page on screen is a page on paper, leave it alone.
    // Any other sort the vet has chosen is applied as before.
    const alreadyInListOrder = (version === 'v1-4' || version === 'v1-5')
      && sortBy === 'Ear-tag number (last 5 digits)'
      && sortDirection !== 'desc'
    const sortedBase = alreadyInListOrder
      ? getSkinTestAnimals(req)
      : sortAnimals(getSkinTestAnimals(req), sortBy, sortDirection)
    // Duplicate detection for the reactor / untested pickers so the
    // vet sees the same DUP flag they saw on the printed list.
    const lastFourCounts = {}
    sortedBase.forEach(function (a) {
      const last4 = String(a.officialId || '').slice(-4)
      lastFourCounts[last4] = (lastFourCounts[last4] || 0) + 1
    })
    return sortedBase.map(function (a) {
      const last4 = String(a.officialId || '').slice(-4)
      // "Check the DOB" flag – animal is around the 42-day minimum
      // testing age (35–49 days). The reporting tables underline
      // the DOB so the vet can spot borderline calves at a glance.
      const daysOld = ageInMonthsFromDob(a.dob)
      const isUnderTestAge = typeof daysOld === 'number'
        && daysOld >= 35
        && daysOld <= 49
      // "Check the TB Vax" flag – the last BCG vaccination was
      // around 9 months ago (8–10 months), so a booster is
      // approaching. Underline the TB Vax cell to flag it.
      const vaxMonths = monthsSinceVaxDate(a.vaccinationDate)
      const isVaxCheckDue = typeof vaxMonths === 'number'
        && vaxMonths >= 8
        && vaxMonths <= 10
      return Object.assign({}, a, {
        earTagParts: formatEarTagParts(a.officialId),
        age: calculateAgeFromDob(a.dob),
        isDuplicate: lastFourCounts[last4] > 1,
        isVaccinated: a.vaccinationStatus === 'Vaccinated',
        isUnderTestAge: isUnderTestAge,
        isVaxCheckDue: isVaxCheckDue
      })
    })
  }

  // ---------------------------------------------------------------------
  // v1-4: single-pass herd review
  //
  // v1-3 makes the vet account for the herd in three passes: "did any
  // cattle react?" -> tick the reactors -> "were all of the cattle
  // tested?" -> tick the ones that weren't. v1-4 collapses that into one
  // review table at /skin-test-reactors where every animal in the herd
  // carries an explicit status:
  //
  //   clear       tested, no detectable reaction (the default)
  //   reaction    continues into the existing measurement journey
  //   not-tested  continues into the existing grouped reason flow
  //
  // Defaulting every animal to "clear" means the vet only records the
  // exceptions, and only has to scan the herd once to find both the
  // reactions and the cattle that were not tested. The reactors-any and
  // all-tested gates are bypassed for v1-4 (see the guards in their own
  // handlers) and everything downstream of this step is unchanged.
  //
  // Scope: single-test journeys (SICCT or DIVA). The "Both" journey still
  // runs the v1-3 two-pass flow, so nothing about it changes here.
  // ---------------------------------------------------------------------

  const V14_STATUSES = ['clear', 'reaction', 'not-tested']

  // The four SICCT readings, in the order they appear in the panel. The
  // labels are used in the error summary, so they match the row and column
  // headings the vet is looking at.
  const V14_MEASUREMENT_FIELDS = [
    { key: 'avianBeforeInjection', label: 'Avian Day 1' },
    { key: 'avianAfter72Hours', label: 'Avian Day 2' },
    { key: 'bovineBeforeInjection', label: 'Bovine Day 1' },
    { key: 'bovineAfter72Hours', label: 'Bovine Day 2' }
  ]

  // Millimetres, to at most one decimal place. Deliberately rejects a
  // leading minus: skin thickness is never negative, so "-4" is a typo
  // rather than a reading. A Day 2 reading LOWER than Day 1 is allowed
  // through untouched - the rules engine treats the negative increase as a
  // negative reaction, which is the correct clinical answer.
  const V14_MM_PATTERN = /^\d*\.?\d+$/

  // V5 is a part-journey experiment: the vet is linked straight to the
  // review table from the prototype index, so none of the pages that
  // would normally set a farm and a test have run. This seeds just
  // enough session state for the review table (and everything after it)
  // to behave as though the vet had walked the full V4 journey.
  //
  // A 102-animal herd - far more than one screen, which is the point:
  // the paging, the record bar and the quick-apply block all exist
  // because the vet cannot hold the list in view at once. In the
  // underlying data every animal is BCG vaccinated, which would normally
  // derive a DIVA test; V5 forces SICCT because that is the journey being
  // tested. Change V14_DEFAULT_CPH to test against a different herd.
  const V14_DEFAULT_CPH = '12/312/6802'
  // The tuberculin batch the demo herd was tested with. Held here rather
  // than in a template so the check page, the batch screen and anything
  // else that shows it are all reading the same value.
  const V14_DEMO_SICCT_BATCH = '138009G'

  // The one animal the vet met at the crush that was not on the printed
  // list. It is the same animal they wrote on the sheet's blank
  // "Additional cattle" page - same ear tag, date of birth, sex, breed
  // and note - so the paper in their hand and the screen in front of
  // them are describing one animal, not two. If the sheet's extra
  // changes (buildExtraCattle, seeded from the herd mark), change this
  // to match or the two stop agreeing.
  // The animal the vet finds in the yard that the printed list does not
  // have. A Mill House tag: herd mark 987654, check digit 5, the same as
  // the other 81 home-bred animals on the list.
  //
  // It used to read UK987654900022 - Mill House's herd mark with a check
  // digit of 9. One herd mark has one check digit, so that tag could not
  // exist, and it sat next to 81 animals that showed the right one.
  //
  // 00231 is outside the 00071-00224 range the list covers, so it reads as
  // a home-bred animal registered after the list was pulled - the ordinary
  // reason an animal is missing from it - and no other animal on the farm
  // ends in 0231, so it does not trip the duplicate last-4 banding.
  const V14_SEEDED_ADDED_CATTLE = [
    {
      officialId: 'UK987654500231',
      breed: 'BB',
      sex: 'M',
      dob: '25/09/2021',
      remarks: 'Not on the printed list.'
    }
  ]

  function v14SeedListSession(req, res) { return v14SeedSession(req, res) }

  // The check-data journey sits outside this closure but needs the same
  // Mill House session, so a reference is published once. The function
  // does not read `version`, so whichever registration lands here first
  // gives the same result.
  if (!recordSeedSession) { recordSeedSession = v14SeedSession }
  // v14CheckList turns the session into one row per animal - status,
  // reason, readings, outcome. The check-data review pages need exactly
  // that, so the v1-4 build of it is published for them. v1-4 rather than
  // any version because v14WithEligibility reads `version`.
  if (version === 'v1-4') {
    recordCheckList = v14CheckList
    recordSaveAnimal = v14SaveOneAnimal
    // V15_REASONS is declared further down this closure, so it is read
    // lazily at request time rather than captured here.
    recordReasons = function () { return V15_REASONS }
    // skinTestEntries is indexed by the animal's position in the sorted
    // list, not by ear tag, so anything writing readings straight into
    // the session needs this map to put them in the right slot.
    recordEntryIndex = v14EntryIndex
  }

  function v14SeedSession(req, res) {
    const data = req.session.data

    if (!data.selectedCattle) {
      const herd = herdData[V14_DEFAULT_CPH]
      if (herd) {
        data.selectedCattle = V14_DEFAULT_CPH
        data.selectedCattleLabel = herd.farm
        data.herd = herd
      }
    }

    // Force a single SICCT test rather than letting the herd's
    // vaccination status derive the type (see the comment above).
    if (!data.skinTestType) {
      data.skinTestType = 'SICCT'
    }
    if (!data.prepareSkinTestType) {
      data.prepareSkinTestType = 'SICCT'
      data.prepareSkinTestPhase = 'sicct'
      data.prepareSkinTestAssignments = null
      data.prepareAssignCompletedTests = []
    }
    if (!Array.isArray(data.skinTestCompletedTests) || !data.skinTestCompletedTests.length) {
      data.skinTestCompletedTests = ['sicct']
    }

    // Test details the vet would have entered on the pages V5 skips.
    // Day 1 is the injection, day 2 the reading 72 hours later, so the
    // review table is being filled in "today".
    if (!data.skinTestDay1Day) {
      const day2 = new Date()
      const day1 = new Date(day2.getTime() - (3 * 24 * 60 * 60 * 1000))
      data.skinTestDay1Day = String(day1.getDate())
      data.skinTestDay1Month = String(day1.getMonth() + 1)
      data.skinTestDay1Year = String(day1.getFullYear())
      data.skinTestDay2Day = String(day2.getDate())
      data.skinTestDay2Month = String(day2.getMonth() + 1)
      data.skinTestDay2Year = String(day2.getFullYear())
    }
    // The batch number, for the same reason as the dates above.
    //
    // The check page was printing "138009G" from a fallback inside its own
    // template, so the number existed on that one page and nowhere else:
    // Change opened an empty field, and anything typed into it changed a
    // value the check page was never reading. Seeded here it is real - the
    // check page reads it, the batch screen opens with it, and an edit
    // sticks. Both stores are written because the batch screen reads
    // skinTestBatchDetails and the older templates read the array.
    if (!Array.isArray(data.skinTestSicctBatches) || !data.skinTestSicctBatches.length) {
      data.skinTestSicctBatches = [V14_DEMO_SICCT_BATCH]
    }
    data.skinTestBatchDetails = data.skinTestBatchDetails || {}
    data.skinTestBatchDetails.sicct = data.skinTestBatchDetails.sicct || {}
    if (!data.skinTestBatchDetails.sicct.batch) {
      data.skinTestBatchDetails.sicct.batch = data.skinTestSicctBatches[0] || V14_DEMO_SICCT_BATCH
    }

    if (!data.administeredBy) {
      data.administeredBy = 'self'
      data.theirRole = 'vet'
    }

    // Written in the same shape the add-another form writes, so a seeded
    // animal and one the vet typed in are indistinguishable downstream.
    // Guarded on "never set" rather than "empty", so removing all three
    // on the added-cattle screen sticks.
    if (!Array.isArray(data.skinTestAddedEntries)) {
      data.skinTestAddedEntries = V14_SEEDED_ADDED_CATTLE.map(function (a) {
        return {
          officialId: a.officialId,
          earTag: a.officialId,
          breed: a.breed,
          sex: a.sex,
          dob: a.dob,
          status: 'done',
          remarks: a.remarks
        }
      })
    }

    // The Prototype Kit copies session data into res.locals.data before
    // the route handler runs, so anything seeded above would not reach
    // the template until the next request. Mirror it across so the very
    // first page load already shows the farm name and test type.
    if (res && res.locals) {
      res.locals.data = Object.assign({}, res.locals.data || {}, data)
    }
  }

  function isV14Review(req) {
    return version === 'v1-4' && req.session.data.skinTestType !== 'Both'
  }

  // Eligibility flags, lifted from the v1-3 mark-untested picker. In v1-3
  // these cues sat on a later page; now that "not tested" is recorded on
  // the same table as reactions, the vet needs them here instead.
  //   - Too young: under the 42-day minimum skin-test age.
  //   - Tested elsewhere: tested on another farm within the last 60 days.
  function v14WithEligibility(req, animals) {
    const phase = getCurrentReactorPhase(req)
    return animals.map(function (a) {
      const days = ageInMonthsFromDob(a.dob)
      const isTooYoung = typeof days === 'number' && days >= 0 && days < 42
      const recent = recentTestFor(a, phase, version === 'v1-4' || version === 'v1-5')
      let ineligibleReason = ''
      let ineligibleDetail = ''
      if (isTooYoung) {
        ineligibleReason = 'Too young to test'
        ineligibleDetail = 'Under the minimum testing age of 42 days.'
      } else if (recent) {
        ineligibleReason = 'Tested on another farm'
        ineligibleDetail = 'Last ' + (recent.type || 'SICCT') + ' test ' + recent.date
          + ', within the 60-day minimum interval.'
      }
      return Object.assign({}, a, {
        isTooYoung: isTooYoung,
        testedElsewhereRecently: !!recent,
        recentTestDate: recent ? recent.date : '',
        recentTestType: recent ? (recent.type || 'SICCT') : '',
        ineligible: !!ineligibleReason,
        ineligibleReason: ineligibleReason,
        ineligibleDetail: ineligibleDetail
      })
    })
  }

  // The status to show for one animal. Prefer what the vet last submitted
  // on this page; otherwise derive it from any reactor / untested state
  // already in the session, so Back links and "Change" links from check
  // your answers round-trip correctly. Anything with no prior state is
  // clear, which is the normal outcome.
  function v14StatusFor(req, officialId) {
    const stored = req.session.data.skinTestReviewStatuses || {}
    if (V14_STATUSES.indexOf(stored[officialId]) !== -1) {
      return stored[officialId]
    }
    const reactors = new Set([
      ...getReactorsForPhase(req, 'sicct'),
      ...getReactorsForPhase(req, 'diva')
    ])
    if (reactors.has(officialId)) return 'reaction'
    const untested = Array.isArray(req.session.data.skinTestUntested)
      ? req.session.data.skinTestUntested
      : []
    if (untested.indexOf(officialId) !== -1) return 'not-tested'
    // Nothing recorded yet: the row opens with nothing selected.
    //
    // Three of the four round 3 participants argued against a pre-set
    // Clear, on clinical grounds - "it's quite hard to actually confirm
    // something's clear. You have to check it multiple times." A default
    // asserts a finding the vet has not made, and makes a row nobody
    // looked at indistinguishable from one they decided about. On a part
    // test that is worse than untidy: an animal at the other site, never
    // touched, would submit as tested.
    //
    // The cost is real - the vet now touches every row rather than only
    // the exceptions - and quick apply is what pays it back.
    //
    // The unrecorded-rows check on submit now does its job: it could
    // never fire while this returned a status.
    return ''
  }

  // Where the vet goes once the review (and any measurements) are done.
  // Not-tested cattle still owing a reason go to the grouped reason page;
  // otherwise carry on to the v1-3 add-cattle question and check answers.
  function v14AfterReviewHref(req) {
    // Read the untested cattle through getUntestedAnimals, the same
    // helper the reasons page itself uses, rather than off the raw
    // skinTestUntested id list. The two can disagree – an id can sit in
    // the session without matching an animal in the current scope – and
    // when they do, this helper would send the vet to a reasons page
    // that has nothing left to ask them.
    const untestedAnimals = getUntestedAnimals(req)
    if (untestedAnimals.length) {
      const reasons = req.session.data.skinTestUntestedReasons || {}
      const outstanding = untestedAnimals.filter(function (a) { return !reasons[a.officialId] })
      if (outstanding.length) {
        return `/${version}/skin-test-untested-reason`
      }
      return untestedReasonsDoneHref(req)
    }
    return `/${version}/skin-test-add-cattle-question`
  }

  // skinTestEntries is indexed by the animal's position in the unsorted
  // herd list, while the review table renders in the vet's chosen sort
  // order. This maps one to the other so an inline measurement is written
  // against the right animal whatever the table is sorted by.
  // Run the TB64 rules over one animal's readings. Returns null until all
  // four are present. Used by both the validation pass and the save, so the
  // "is this a reactor?" question is only ever answered in one place.
  function v14Interpret(m) {
    const aPre = parseFloat(m.avianBeforeInjection)
    const aPost = parseFloat(m.avianAfter72Hours)
    const bPre = parseFloat(m.bovineBeforeInjection)
    const bPost = parseFloat(m.bovineAfter72Hours)
    if (isNaN(aPre) || isNaN(aPost) || isNaN(bPre) || isNaN(bPost)) return null
    return sicctInterpretation.interpretSicct({
      avianIncrease: aPost - aPre,
      bovineIncrease: bPost - bPre,
      avianOedema: m.avianOedema,
      bovineOedema: m.bovineOedema,
      interpretationType: 'standard'
    })
  }

  // The reactor tag is the tag physically applied to an animal being
  // taken as a reactor, so the number only exists for one. An
  // inconclusive animal is left in place to be re-tested and is not
  // tagged, so there is nothing to write down and nothing to ask for.
  function v14NeedsReactorReference(interpretation) {
    if (!interpretation) return false
    return interpretation.resultCode === 'REACTOR'
  }

  function v14EntryIndex(req) {
    const map = new Map()
    getSkinTestAnimals(req).forEach(function (a, i) { map.set(a.officialId, i) })
    return map
  }

  // One row per animal for the Check and send page, in printed-sheet
  // order, with whatever the vet recorded against each one. Only v1-4
  // asks for this; every other version renders its own confirmation
  // view and never reads it.
  // Save one animal's record. The single-record edit screen in the
  // check-data journey writes through here, so one animal edited on its
  // own lands in exactly the session shape the bulk review POST produces.
  // Four stores have to agree: the status, the reactor list for the
  // phase, the untested list with its reasons, and the readings.
  function v14SaveOneAnimal(req, officialId, change) {
    const data = req.session.data
    const phase = getCurrentReactorPhase(req)
    const status = change.status

    const statuses = Object.assign({}, data.skinTestReviewStatuses || {})
    statuses[officialId] = status
    data.skinTestReviewStatuses = statuses

    const reactors = new Set(getReactorsForPhase(req, phase))
    if (status === 'reaction') reactors.add(officialId)
    else reactors.delete(officialId)
    const reactorIds = Array.from(reactors)
    setReactorsForPhase(req, phase, reactorIds)
    data.anyReactors = reactorIds.length ? 'yes' : 'no'
    const anyByPhase = Object.assign({}, data.anyReactorsByPhase || {})
    anyByPhase[phase] = reactorIds.length ? 'yes' : 'no'
    data.anyReactorsByPhase = anyByPhase

    const untested = (Array.isArray(data.skinTestUntested) ? data.skinTestUntested : [])
      .filter(function (id) { return id !== officialId })
    const reasons = Object.assign({}, data.skinTestUntestedReasons || {})
    const others = Object.assign({}, data.skinTestUntestedReasonOthers || {})
    if (status === 'not-tested') {
      untested.push(officialId)
      reasons[officialId] = change.reason || ''
      others[officialId] = change.reason === 'other' ? (change.reasonOther || '') : ''
    } else {
      delete reasons[officialId]
      delete others[officialId]
    }
    data.skinTestUntested = untested
    data.skinTestUntestedReasons = reasons
    data.skinTestUntestedReasonOthers = others

    const allEntries = getEntries(req)
    const stored = Array.isArray(data.skinTestEntries) ? data.skinTestEntries.slice() : []
    while (stored.length < allEntries.length) stored.push(blankEntry())
    const at = v14EntryIndex(req).get(officialId)
    if (typeof at === 'number') {
      if (status === 'reaction') {
        const m = change.measurements || {}
        // The result is calculated, never entered - the same authoritative
        // pass the bulk review runs.
        const interpretation = v14Interpret(m)
        stored[at] = Object.assign({}, stored[at] || blankEntry(), {
          status: 'done',
          performedTest: 'SICCT',
          divaStatus: 'done',
          overallResult: interpretation
            ? sicctInterpretation.toLegacyOverallResult(interpretation.resultCode)
            : '',
          sicctInterpretation: interpretation
        }, m)
      } else {
        stored[at] = blankEntry()
      }
    }
    data.skinTestEntries = stored
  }

  function v14CheckList(req) {
    const animals = getReportingAnimalsWithFlags(req)
    if (!animals.length) return []
    const entries = Array.isArray(req.session.data.skinTestEntries)
      ? req.session.data.skinTestEntries
      : []
    const entryIndex = v14EntryIndex(req)
    const reasons = req.session.data.skinTestUntestedReasons || {}
    const reasonOthers = req.session.data.skinTestUntestedReasonOthers || {}
    const reasonText = {}
    V15_REASONS.forEach(function (r) { reasonText[r.value] = r.text })

    return v14WithEligibility(req, animals).map(function (a, i) {
      const status = v14StatusFor(req, a.officialId)
      const m = entries[entryIndex.get(a.officialId)] || {}
      const row = {
        n: i + 1,
        officialId: a.officialId,
        // The same split the review table and the printed sheet use, so
        // the last 4 digits can be picked out and a shared last 4 can be
        // banded, exactly as they are on the paper.
        earTagParts: a.earTagParts || formatEarTagParts(a.officialId),
        isDuplicate: !!a.isDuplicate,
        sex: a.sex,
        breed: a.breed,
        dob: a.dob,
        status: status,
        measurements: null,
        reactorReference: '',
        reasonLabel: '',
        partTest: false,
        // outcome drives the tag: 'clear', 'reactor', 'inconclusive',
        // 'pass', 'incomplete' or 'not-tested'.
        outcome: 'clear',
        outcomeLabel: 'Clear'
      }

      if (status === 'not-tested') {
        const reason = reasons[a.officialId] || ''
        row.outcome = 'not-tested'
        row.outcomeLabel = 'Not tested'
        row.reasonLabel = reason === 'other'
          ? (reasonOthers[a.officialId] || 'Other reason')
          : (reasonText[reason] || 'No reason given')
        row.partTest = isStillToTestReason(reason)
        return row
      }

      if (status === 'reaction') {
        row.measurements = {
          avianBeforeInjection: m.avianBeforeInjection || '',
          avianAfter72Hours: m.avianAfter72Hours || '',
          bovineBeforeInjection: m.bovineBeforeInjection || '',
          bovineAfter72Hours: m.bovineAfter72Hours || '',
          avianOedema: m.avianOedema || 'C',
          bovineOedema: m.bovineOedema || 'C'
        }
        row.reactorReference = m.reactorReference || ''
        const interpretation = v14Interpret(row.measurements)
        if (!interpretation) {
          // The vet submitted with readings missing, having been asked
          // to confirm that. Saying so here is the whole point of the
          // page - it is the last chance to notice.
          row.outcome = 'incomplete'
          row.outcomeLabel = 'Readings missing'
        } else if (interpretation.resultCode === 'REACTOR') {
          row.outcome = 'reactor'
          row.outcomeLabel = 'Reactor'
        } else if (interpretation.resultCode === 'INCONCLUSIVE') {
          row.outcome = 'inconclusive'
          row.outcomeLabel = 'Inconclusive'
        } else {
          // Readings taken, rules applied, no reaction. Different from
          // an animal the vet never opened - that one is just Clear.
          row.outcome = 'pass'
          row.outcomeLabel = 'Pass'
        }
        return row
      }

      return row
    })
    // Every animal, in printed-sheet order. The vet reads down their
    // paper copy line by line, and a line they cannot find on screen is
    // exactly the one worth finding.
  }

  function renderV14Review(req, res, options) {
    options = options || {}
    v14SeedSession(req, res)
    const animals = getReportingAnimalsWithFlags(req)
    if (!animals.length) {
      return res.redirect(`/${version}/dashboard`)
    }
    // Values for the inline detail panels. Measurements come from the
    // saved skinTestEntries (keyed by the animal's position in the
    // canonical list), reasons from the untested maps – the same places
    // the rest of the journey reads them from, so a Change link back to
    // this page shows what the vet already entered.
    const entries = Array.isArray(req.session.data.skinTestEntries)
      ? req.session.data.skinTestEntries
      : []
    const entryIndex = v14EntryIndex(req)
    const reasons = req.session.data.skinTestUntestedReasons || {}
    const reasonOthers = req.session.data.skinTestUntestedReasonOthers || {}
    const submitted = options.statuses || null
    const submittedMeasurements = options.measurements || null
    const submittedReasons = options.reasons || null
    const reasonErrors = options.reasonErrors || {}
    const measurementErrors = options.measurementErrors || {}

    const rows = v14WithEligibility(req, animals).map(function (a) {
      const status = submitted
        ? (submitted[a.officialId] || 'clear')
        : v14StatusFor(req, a.officialId)
      const saved = entries[entryIndex.get(a.officialId)] || {}
      const m = (submittedMeasurements && submittedMeasurements[a.officialId]) || {}
      const measurements = {
        avianBeforeInjection: m.avianBeforeInjection || saved.avianBeforeInjection || '',
        avianAfter72Hours: m.avianAfter72Hours || saved.avianAfter72Hours || '',
        bovineBeforeInjection: m.bovineBeforeInjection || saved.bovineBeforeInjection || '',
        bovineAfter72Hours: m.bovineAfter72Hours || saved.bovineAfter72Hours || '',
        avianOedema: m.avianOedema || saved.avianOedema || 'C',
        bovineOedema: m.bovineOedema || saved.bovineOedema || 'C',
        reactorReference: m.reactorReference || saved.reactorReference || ''
      }
      const refErrors = measurementErrors[a.officialId] || {}
      return Object.assign({}, a, {
        status: status,
        measurements: measurements,
        // Whether the reactor tag box is on the page when it first loads.
        // The readings decide it, but a number the vet already typed and
        // an error standing against the field both keep it visible - work
        // must never be hidden from the person who did it, and an error
        // summary must never link to a field that is not there.
        needsReactorRef: v14NeedsReactorReference(v14Interpret(measurements))
          || !!measurements.reactorReference
          || !!refErrors.reactorReference,
        reason: (submittedReasons ? submittedReasons[a.officialId] : reasons[a.officialId]) || '',
        reasonOther: (submittedReasons ? (options.reasonOthers || {})[a.officialId] : reasonOthers[a.officialId]) || '',
        reasonError: !!reasonErrors[a.officialId],
        measurementErrors: measurementErrors[a.officialId] || {}
      })
    })
    // A row with no status is not clear - it is untouched, and the
    // difference is the whole point of removing the default. Anything the
    // tally cannot account for goes to "still to record".
    const counts = { clear: 0, reaction: 0, notTested: 0, todo: 0 }
    rows.forEach(function (r) {
      if (r.status === 'reaction') counts.reaction++
      else if (r.status === 'not-tested') counts.notTested++
      else if (r.status === 'clear') counts.clear++
      else counts.todo++
    })

    res.render(`${version}/skin-test-review`, {
      animals: rows,
      counts: counts,
      totalCattle: rows.length,
      currentTestLabel: getCurrentReactorPhaseLabel(req),
      backHref: `/${version}/dashboard`,
      showOverride: !!options.showOverride,
      sortBy: req.session.data.prepareSkinTestUntestedSortBy || 'Ear-tag number (last 5 digits)',
      sortDirection: req.session.data.prepareSkinTestUntestedSortDirection || 'asc',
      errors: options.errors,
      errorSummary: options.errorSummary
    })
  }

  function handleV14Review(req, res) {
    v14SeedSession(req, res)
    const animals = getReportingAnimalsWithFlags(req)
    const phase = getCurrentReactorPhase(req)
    const statuses = {}
    const reactions = []
    const notTested = []

    // Nothing is pre-selected, so a row can genuinely have no answer.
    // That is caught below rather than quietly turned into "clear" -
    // inventing a negative TB result for an animal nobody looked at is
    // the exact failure the pre-selection used to risk.
    // Values typed into the inline panels. Only kept for animals whose
    // status still matches the panel – a vet who marks a reaction, types a
    // reading, then switches the animal back to Clear should not leave a
    // stray measurement behind.
    const measurements = {}
    const inlineReasons = {}
    const inlineReasonOthers = {}
    const reasonErrors = {}

    animals.forEach(function (a) {
      const raw = req.body['status-' + a.officialId]
      const status = V14_STATUSES.indexOf(raw) !== -1 ? raw : ''
      statuses[a.officialId] = status
      if (status === 'reaction') {
        reactions.push(a.officialId)
        const avianOedemaRaw = (req.body['avianOedema-' + a.officialId] || 'C').trim().toUpperCase()
        const bovineOedemaRaw = (req.body['bovineOedema-' + a.officialId] || 'C').trim().toUpperCase()
        measurements[a.officialId] = {
          avianBeforeInjection: (req.body['avianBeforeInjection-' + a.officialId] || '').trim(),
          avianAfter72Hours: (req.body['avianAfter72Hours-' + a.officialId] || '').trim(),
          bovineBeforeInjection: (req.body['bovineBeforeInjection-' + a.officialId] || '').trim(),
          bovineAfter72Hours: (req.body['bovineAfter72Hours-' + a.officialId] || '').trim(),
          avianOedema: avianOedemaRaw === 'SO' ? 'SO' : 'C',
          bovineOedema: bovineOedemaRaw === 'SO' ? 'SO' : 'C',
          reactorReference: (req.body['reactorReference-' + a.officialId] || '').trim()
        }
      }
      // Not tested cattle are collected here and given their reasons on
      // the bulk page afterwards - one reason usually covers several
      // animals, so asking per row on this table would be slower. Any
      // reason already recorded (on the bulk page, or via "Add reason
      // now") is carried forward untouched.
      if (status === 'not-tested') {
        notTested.push(a.officialId)
        // "Add reason now" opens the reasons on this page, so one may have
        // been chosen here. It is optional - anything left blank falls
        // through to the bulk page, which is where most vets will do it.
        const reason = (req.body['reason-' + a.officialId] || '').trim()
        const reasonOther = (req.body['reasonOther-' + a.officialId] || '').trim()
        const existing = (req.session.data.skinTestUntestedReasons || {})[a.officialId]
        if (reason) {
          inlineReasons[a.officialId] = reason
          if (reason === 'other') inlineReasonOthers[a.officialId] = reasonOther
        } else if (existing) {
          inlineReasons[a.officialId] = existing
          const existingOther = (req.session.data.skinTestUntestedReasonOthers || {})[a.officialId]
          if (existingOther) inlineReasonOthers[a.officialId] = existingOther
        }
      }
    })

    // --- Save and continue later ---------------------------------------
    // Park the report and go back to the dashboard, where it waits as
    // "In progress" and can be resumed.
    //
    // Deliberately ahead of validation. Pausing part way through is the
    // point, so a reading the vet has not taken yet cannot be a reason to
    // refuse to save. And it writes only what they have entered - it does
    // not mark the phase complete or set the reactor lists, because
    // nothing about the report is decided until they come back and press
    // Continue.
    if ((req.body.saveAction || '').trim() === 'save-exit') {
      req.session.data.skinTestReviewStatuses = statuses
      req.session.data.skinTestUntested = notTested
      req.session.data.skinTestUntestedReasons = inlineReasons
      req.session.data.skinTestUntestedReasonOthers = inlineReasonOthers

      // Measurements live in skinTestEntries, indexed by the animal's
      // position in the herd - the same place the finished report reads
      // them from, so a resumed page shows exactly what was typed.
      const partial = Array.isArray(req.session.data.skinTestEntries)
        ? [...req.session.data.skinTestEntries]
        : []
      while (partial.length < getEntries(req).length) partial.push(blankEntry())
      const partialIndex = v14EntryIndex(req)
      Object.keys(measurements).forEach(function (id) {
        const i = partialIndex.get(id)
        if (typeof i !== 'number') return
        // Only a complete set of four readings has a result. A part-filled
        // row is stored as typed and left without one.
        const interpretation = v14Interpret(measurements[id])
        partial[i] = Object.assign({}, partial[i] || blankEntry(), {
          overallResult: interpretation
            ? sicctInterpretation.toLegacyOverallResult(interpretation.resultCode)
            : '',
          sicctInterpretation: interpretation
        }, measurements[id])
      })
      req.session.data.skinTestEntries = partial

      req.session.data.currentSkinTestPhase = phase
      req.session.data.savedBanner = 'skin-test-report'
      req.session.data.skinTestInProgress = true
      return res.redirect(`/${version}/dashboard`)
    }

    // --- Validation ----------------------------------------------------
    // Built in the table's own order, so the error summary reads down the
    // page rather than jumping about.
    //
    // Two kinds of problem, treated differently:
    //   * A reading that is not a number is always wrong, so it always
    //     blocks. There is no sense in letting "abc" through.
    //   * A reading that is simply missing blocks the first time, then
    //     offers an acknowledgement so the vet can submit anyway - a
    //     reading can be illegible or impossible to take. This mirrors
    //     /skin-test-table, so V5 is no stricter than the journey it forks.
    const measurementErrors = {}
    const errorList = []
    const missingIds = []
    let anyInvalid = false
    // Errors the vet has to fix - a typo, or a missing reactor reference.
    // Distinct from readings that are simply absent, which can be waved
    // through once acknowledged.
    let anyHardError = false

    // The kit posts an array when the hidden "_unchecked" companion field
    // is present, so normalise to a plain yes/no.
    const overrideRaw = req.body.overrideMissingReadings
    const override = Array.isArray(overrideRaw)
      ? overrideRaw.indexOf('yes') !== -1
      : (overrideRaw || '').trim() === 'yes'

    animals.forEach(function (a) {
      const id = a.officialId
      const status = statuses[id]

      if (status !== 'reaction') return
      const m = measurements[id] || {}
      const fieldErrors = {}
      let missingField = null

      V14_MEASUREMENT_FIELDS.forEach(function (f) {
        const raw = m[f.key]
        if (raw === '') {
          if (!missingField) missingField = f.key
          return
        }
        if (!V14_MM_PATTERN.test(raw)) {
          fieldErrors[f.key] = f.label + ' must be a number in millimetres, like 12 or 12.5'
        } else if (parseFloat(raw) > 99) {
          fieldErrors[f.key] = f.label + ' must be 99mm or less'
        }
      })

      V14_MEASUREMENT_FIELDS.forEach(function (f) {
        if (!fieldErrors[f.key]) return
        anyInvalid = true
        anyHardError = true
        errorList.push({ text: fieldErrors[f.key] + ' for ' + id, href: '#' + f.key + '-' + id })
      })

      if (missingField) {
        missingIds.push(id)
        fieldErrors.missing = true
        errorList.push({
          text: 'Enter all four readings for ' + id,
          href: '#' + missingField + '-' + id
        })
      }

      // Reactor reference. Only asked for once the readings actually
      // produce a reactor, so this can never fire at the same time as a
      // missing reading (the rules engine returns null until all four are
      // in). It is the identifier APHA traces the animal by, so it is not
      // covered by the "submit with readings missing" acknowledgement.
      if (v14NeedsReactorReference(v14Interpret(m)) && !m.reactorReference) {
        anyHardError = true
        fieldErrors.reactorReference = 'Enter the reactor tag number'
        errorList.push({
          text: 'Enter the reactor tag number for ' + id,
          href: '#reactorReference-' + id
        })
      }

      if (Object.keys(fieldErrors).length) measurementErrors[id] = fieldErrors
    })

    // Nothing may be submitted while an animal has no result at all.
    // This is the check the pre-selected "clear" made impossible: every
    // row always had an answer, whether the vet had looked at it or not,
    // so an animal nobody went through was indistinguishable from one
    // recorded as tested with no reaction.
    const unrecorded = animals.filter(function (a) { return !statuses[a.officialId] })
    if (unrecorded.length) {
      const firstNumber = animals.indexOf(unrecorded[0]) + 1
      errorList.unshift({
        text: unrecorded.length === 1
          ? 'Record a result for animal ' + firstNumber
          : 'Record a result for ' + unrecorded.length + ' cattle you have not been through yet',
        href: '#animal-' + firstNumber
      })
    }

    // Missing readings alone can be waved through once acknowledged;
    // anything else has to be fixed.
    const blocked = unrecorded.length > 0 || anyHardError || (missingIds.length > 0 && !override)

    if (blocked) {
      const summaryList = missingIds.length && !anyHardError && !unrecorded.length
        ? errorList.concat([{ text: 'Or submit the report with readings missing', href: '#overrideMissingReadings' }])
        : errorList
      return renderV14Review(req, res, {
        statuses: statuses,
        measurements: measurements,
        measurementErrors: measurementErrors,
        reasons: inlineReasons,
        reasonOthers: inlineReasonOthers,
        reasonErrors: reasonErrors,
        // Only offer the acknowledgement once everything else is valid -
        // otherwise the vet could tick past a typo.
        showOverride: missingIds.length > 0 && !anyHardError && !unrecorded.length,
        errorSummary: {
          titleText: 'There is a problem',
          errorList: summaryList
        }
      })
    }

    req.session.data.skinTestReviewStatuses = statuses

    // Reactions feed the existing measurement journey. anyReactors /
    // anyReactorsByPhase are still written so the pages downstream that
    // read them (check your answers, the per-test confirm page) behave
    // exactly as they do in v1-3.
    setReactorsForPhase(req, phase, reactions)
    req.session.data.anyReactors = reactions.length ? 'yes' : 'no'
    const anyReactorsByPhase = Object.assign({}, req.session.data.anyReactorsByPhase || {})
    anyReactorsByPhase[phase] = reactions.length ? 'yes' : 'no'
    req.session.data.anyReactorsByPhase = anyReactorsByPhase

    // Not-tested cattle feed the existing grouped reason flow. Prune any
    // reason held against an animal the vet has since moved back to clear
    // or up to a reaction.
    // Reasons are captured inline now, so they are simply what the vet
    // just chose. Anything held against an animal no longer marked Not
    // tested falls away with it.
    req.session.data.skinTestUntested = notTested
    req.session.data.skinTestUntestedReasons = inlineReasons
    req.session.data.skinTestUntestedReasonOthers = inlineReasonOthers
    req.session.data.currentUntestedIndex = 0

    // Seed a blank measurement row per animal, exactly as the v1-3
    // reactor POST does, so the measurement screens have somewhere to
    // write back to.
    const allEntries = getEntries(req)
    const stored = Array.isArray(req.session.data.skinTestEntries)
      ? [...req.session.data.skinTestEntries]
      : []
    while (stored.length < allEntries.length) stored.push(blankEntry())

    // Write the inline measurements straight into those entries, so the
    // follow-up screen and check-your-answers read them exactly as if they
    // had been typed on the measurement page.
    const entryIndex = v14EntryIndex(req)
    Object.keys(measurements).forEach(function (id) {
      const i = entryIndex.get(id)
      if (typeof i !== 'number') return
      const m = measurements[id]

      // The result is calculated, never entered. The page shows a live
      // preview as the vet types; this is the authoritative pass, run
      // through the same TB64 rules engine /skin-test-table uses, so the
      // stored value can never drift from what the rules say.
      const interpretation = v14Interpret(m)

      stored[i] = Object.assign({}, stored[i] || blankEntry(), {
        status: 'done',
        performedTest: 'SICCT',
        divaStatus: 'done',
        overallResult: interpretation
          ? sicctInterpretation.toLegacyOverallResult(interpretation.resultCode)
          : '',
        sicctInterpretation: interpretation
      }, m)
    })
    req.session.data.skinTestEntries = stored

    const completed = Array.isArray(req.session.data.completedSkinTestPhases)
      ? req.session.data.completedSkinTestPhases.slice()
      : []
    if (completed.indexOf(phase) === -1) completed.push(phase)
    req.session.data.completedSkinTestPhases = completed

    // A reacting animal's whole SICCT reading - both sites' measurements,
    // the C / SO description and the calculated result - is now captured
    // on the review page itself, so there is no measurement screen left to
    // send the vet to. DIVA journeys still use their own loop.
    if (reactions.length && phase === 'diva') {
      req.session.data.currentSkinTestPhase = 'diva'
      req.session.data.currentDivaIndex = 0
      return res.redirect(`/${version}/skin-test-diva/0`)
    }
    if (reactions.length) {
      req.session.data.currentSkinTestPhase = 'sicct'
      req.session.data.currentSkinTestIndex = 0
    }

    res.redirect(v14AfterReviewHref(req))
  }

  // =====================================================================
  // v1-5 - the "add another" variant of V5
  // =====================================================================
  // The table variant asks the vet to account for every animal. This one
  // asks them to name only the exceptions: the cattle that reacted, and
  // the cattle that were not tested. Anything they do not name is
  // reported as tested with no reaction, which is the same end state -
  // the two variants write identical session data, so everything
  // downstream (check your answers, the confirmation, the report) cannot
  // tell them apart. That is deliberate: the only thing under test is the
  // interaction.
  //
  // Both pages use the Design System's "add another" pattern, driven by
  // the server rather than by script, so they work with JavaScript off.
  // Add, Remove and Continue are all submit buttons on the same form; the
  // handler rebuilds the rows from the posted arrays, applies whichever
  // button was pressed, and either re-renders or moves on.

  function isV15AddAnother(req) {
    return version === 'v1-5' && req.session.data.skinTestType !== 'Both'
  }

  // The same five reasons as the table variant, and the same values, so
  // the two write identical data and stay comparable in research - the
  // interaction is the only thing that differs between them.
  //
  // The hints are carried here but this page renders a select, which
  // cannot show per-option hints the way radios can. They are kept so
  // both variants read from one list, and so the wording only ever has to
  // be changed in one place.
  const V15_REASONS = [
    { value: 'not-presented', text: 'Not presented',
      hint: 'Missing, not brought in, or withdrawn by the keeper' },
    { value: 'not-possible', text: 'Not possible to test',
      hint: 'Came to the crush but could not be handled or restrained safely' },
    { value: 'not-eligible', text: 'Not eligible',
      hint: 'Too young, or tested elsewhere in the last 60 days' },
    { value: 'dead', text: 'Dead' },
    { value: 'other', text: 'Other reason' }
  ]

  // Every animal in the herd, as options for the ear-tag inputs. The
  // browser's own datalist filtering does the rest: typing the last few
  // digits narrows the list, which is what the vet reads off the paper
  // sheet. No autocomplete library, so nothing to break with script off.
  function v15Suggestions(req) {
    return getReportingAnimalsWithFlags(req).map(function (a) {
      return {
        officialId: a.officialId,
        label: a.officialId + ' - ' + [a.sex, a.breed, a.dob ? 'DOB ' + a.dob : '']
          .filter(Boolean).join(', ')
      }
    })
  }

  // Match what the vet typed against the herd. Generous on purpose: they
  // may pick a whole ear tag from the datalist, or type just the last few
  // digits off the sheet. Spaces are ignored so "UK 9876 5450 0071" works.
  // Returns the animal, or null, or the string 'ambiguous' when a partial
  // number matches more than one animal - which happens in this herd,
  // several pairs share their last 4 digits.
  function v15MatchAnimal(req, raw) {
    const typed = String(raw || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase()
    if (!typed) return null
    const animals = getReportingAnimalsWithFlags(req)
    const norm = function (id) { return String(id || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase() }
    const exact = animals.filter(function (a) { return norm(a.officialId) === typed })
    if (exact.length === 1) return exact[0]
    const ends = animals.filter(function (a) { return norm(a.officialId).endsWith(typed) })
    if (ends.length === 1) return ends[0]
    if (ends.length > 1) return 'ambiguous'
    return null
  }

  // Rebuild the rows from what was posted. Both pages post parallel
  // arrays - one entry per block on screen - so a row is just the same
  // index across each of them.
  function v15PostedRows(req, fields) {
    const arrays = {}
    let length = 0
    fields.forEach(function (f) {
      const raw = req.body[f]
      const list = Array.isArray(raw) ? raw : (raw === undefined ? [] : [raw])
      arrays[f] = list
      length = Math.max(length, list.length)
    })
    const rows = []
    for (let i = 0; i < length; i++) {
      const row = {}
      fields.forEach(function (f) { row[f] = String(arrays[f][i] === undefined ? '' : arrays[f][i]).trim() })
      rows.push(row)
    }
    return rows
  }

  // Which submit button was pressed. "remove" carries the index of the
  // block to drop.
  function v15Action(req) {
    const raw = String(req.body.action || 'continue')
    if (raw.indexOf('remove:') === 0) {
      return { name: 'remove', index: parseInt(raw.slice(7), 10) }
    }
    if (raw === 'add') return { name: 'add' }
    return { name: 'continue' }
  }

  // Error summary wording. Most messages need the row appending - "Enter
  // the ear tag number" means nothing on its own in a list of ten. But a
  // message that already names two rows ("UK...0074 has already been
  // added as animal 1") reads as nonsense with a third reference bolted
  // on the end, so those say so and are left alone.
  function v15Summary(message, label, n) {
    return message.selfContained
      ? message.text
      : message.text + ' for ' + label + ' ' + n
  }

  // A row the vet has not touched at all. Left over from pressing Add and
  // then changing their mind, so it is dropped on Continue rather than
  // being reported as an error.
  function v15RowIsBlank(row) {
    return Object.keys(row).every(function (k) { return !row[k] })
  }

  // --- Record skin test measurements -----------------------------------
  const V15_REACTION_FIELDS = [
    'reactionEarTag',
    'avianBeforeInjection', 'avianAfter72Hours', 'avianOedema',
    'bovineBeforeInjection', 'bovineAfter72Hours', 'bovineOedema',
    'reactorReference'
  ]

  function v15BlankReaction() {
    return {
      reactionEarTag: '',
      avianBeforeInjection: '', avianAfter72Hours: '', avianOedema: 'C',
      bovineBeforeInjection: '', bovineAfter72Hours: '', bovineOedema: 'C',
      reactorReference: ''
    }
  }

  // Rows to show when the vet arrives, or comes back through a Change
  // link. Rebuilt from the same session data the table variant writes, so
  // either variant can render what the other recorded.
  function v15SavedReactions(req) {
    const entries = Array.isArray(req.session.data.skinTestEntries)
      ? req.session.data.skinTestEntries
      : []
    const index = v14EntryIndex(req)
    const rows = []
    getReactorsForPhase(req, getCurrentReactorPhase(req)).forEach(function (id) {
      const saved = entries[index.get(id)] || {}
      rows.push({
        reactionEarTag: id,
        avianBeforeInjection: saved.avianBeforeInjection || '',
        avianAfter72Hours: saved.avianAfter72Hours || '',
        avianOedema: saved.avianOedema === 'SO' ? 'SO' : 'C',
        bovineBeforeInjection: saved.bovineBeforeInjection || '',
        bovineAfter72Hours: saved.bovineAfter72Hours || '',
        bovineOedema: saved.bovineOedema === 'SO' ? 'SO' : 'C',
        reactorReference: saved.reactorReference || ''
      })
    })
    return rows
  }

  function renderV15Reactions(req, res, options) {
    options = options || {}
    v14SeedSession(req, res)
    const rows = options.rows || v15SavedReactions(req)
    // Always one block on screen, so the page never opens on nothing.
    if (!rows.length) rows.push(v15BlankReaction())
    res.render(`${version}/skin-test-reactions`, {
      rows: rows.map(function (row, i) {
        const interpretation = v15RowIsBlank(row) ? null : v14Interpret(row)
        const rowErrors = (options.rowErrors || [])[i] || {}
        return Object.assign({}, row, {
          number: i + 1,
          errors: rowErrors,
          resultLabel: interpretation ? interpretation.resultLabel : '',
          resultTag: interpretation ? v15ResultTag(interpretation.resultCode) : '',
          // See the note on the v1-4 rows: the readings decide, but an
          // existing value or a standing error keeps the box on the page.
          needsReactorRef: v14NeedsReactorReference(interpretation)
            || !!row.reactorReference
            || !!rowErrors.reactorReference
        })
      }),
      total: rows.length,
      suggestions: v15Suggestions(req),
      totalCattle: getReportingAnimalsWithFlags(req).length,
      currentTestLabel: getCurrentReactorPhaseLabel(req),
      backHref: `/${version}/dashboard`,
      showOverride: !!options.showOverride,
      // Add and Remove are submits, so the page reloads and focus would
      // otherwise go back to the top of the document. These tell the page
      // where to put it instead.
      focusRow: options.focusRow || null,
      focusAdd: !!options.focusAdd,
      errorSummary: options.errorSummary
    })
  }

  function v15ResultTag(code) {
    if (code === 'REACTOR') return 'red'
    if (code === 'INCONCLUSIVE') return 'yellow'
    return 'green'
  }

  function handleV15Reactions(req, res) {
    v14SeedSession(req, res)
    let rows = v15PostedRows(req, V15_REACTION_FIELDS)
    const action = v15Action(req)

    if (action.name === 'add') {
      rows.push(v15BlankReaction())
      return renderV15Reactions(req, res, { rows: rows, focusRow: rows.length })
    }
    if (action.name === 'remove') {
      rows.splice(action.index, 1)
      if (!rows.length) rows.push(v15BlankReaction())
      return renderV15Reactions(req, res, { rows: rows, focusAdd: true })
    }

    // Continue. A block the vet opened and never filled in is dropped
    // rather than held against them.
    rows = rows.filter(function (row) { return !v15RowIsBlank(row) })

    const overrideRaw = req.body.overrideMissingReadings
    const override = Array.isArray(overrideRaw)
      ? overrideRaw.indexOf('yes') !== -1
      : String(overrideRaw || '').trim() === 'yes'

    const rowErrors = []
    const errorList = []
    const seen = new Map()
    let anyHardError = false
    let anyMissing = false

    rows.forEach(function (row, i) {
      const errors = {}
      const n = i + 1

      const match = v15MatchAnimal(req, row.reactionEarTag)
      if (!row.reactionEarTag) {
        errors.reactionEarTag = 'Enter the ear tag number'
      } else if (match === 'ambiguous') {
        errors.reactionEarTag = 'Enter more of the ear tag - more than one animal ends ' + row.reactionEarTag
      } else if (!match) {
        errors.reactionEarTag = 'No animal on this holding matches ' + row.reactionEarTag
      } else if (seen.has(match.officialId)) {
        errors.reactionEarTag = match.officialId + ' has already been added as reaction ' + seen.get(match.officialId)
        errors.reactionEarTagSelfContained = true
      } else {
        seen.set(match.officialId, n)
        row.officialId = match.officialId
      }

      V14_MEASUREMENT_FIELDS.forEach(function (f) {
        const raw = row[f.key]
        if (raw === '') {
          anyMissing = true
          errors.missing = true
          return
        }
        if (!V14_MM_PATTERN.test(raw)) {
          errors[f.key] = f.label + ' must be a number in millimetres, like 12 or 12.5'
        } else if (parseFloat(raw) > 99) {
          errors[f.key] = f.label + ' must be 99mm or less'
        }
      })

      if (v14NeedsReactorReference(v14Interpret(row)) && !row.reactorReference) {
        errors.reactorReference = 'Enter the reactor tag number'
      }

      // Summary order follows the page, so the list reads top to bottom.
      if (errors.reactionEarTag) {
        errorList.push({
          text: v15Summary({ text: errors.reactionEarTag, selfContained: errors.reactionEarTagSelfContained }, 'reaction', n),
          href: '#reactionEarTag-' + n
        })
      }
      V14_MEASUREMENT_FIELDS.forEach(function (f) {
        if (errors[f.key]) {
          errorList.push({ text: errors[f.key] + ' for reaction ' + n, href: '#' + f.key + '-' + n })
        }
      })
      if (errors.missing) {
        errorList.push({ text: 'Enter all four readings for reaction ' + n, href: '#avianBeforeInjection-' + n })
      }
      if (errors.reactorReference) {
        errorList.push({ text: errors.reactorReference + ' for reaction ' + n, href: '#reactorReference-' + n })
      }

      const hard = Object.keys(errors).filter(function (k) {
        return k !== 'missing' && k !== 'reactionEarTagSelfContained'
      })
      if (hard.length) anyHardError = true
      rowErrors.push(errors)
    })

    if (anyHardError || (anyMissing && !override)) {
      const summaryList = (anyMissing && !anyHardError)
        ? errorList.concat([{ text: 'Or submit the report with readings missing', href: '#overrideMissingReadings' }])
        : errorList
      return renderV15Reactions(req, res, {
        rows: rows,
        rowErrors: rowErrors,
        showOverride: anyMissing && !anyHardError,
        errorSummary: { titleText: 'There is a problem', errorList: summaryList }
      })
    }

    // --- Save, writing exactly what the table variant writes ----------
    const phase = getCurrentReactorPhase(req)
    const reactorIds = rows.map(function (row) { return row.officialId })

    setReactorsForPhase(req, phase, reactorIds)
    req.session.data.anyReactors = reactorIds.length ? 'yes' : 'no'
    const anyReactorsByPhase = Object.assign({}, req.session.data.anyReactorsByPhase || {})
    anyReactorsByPhase[phase] = reactorIds.length ? 'yes' : 'no'
    req.session.data.anyReactorsByPhase = anyReactorsByPhase

    const allEntries = getEntries(req)
    const stored = Array.isArray(req.session.data.skinTestEntries)
      ? [...req.session.data.skinTestEntries]
      : []
    while (stored.length < allEntries.length) stored.push(blankEntry())

    const entryIndex = v14EntryIndex(req)
    rows.forEach(function (row) {
      const i = entryIndex.get(row.officialId)
      if (typeof i !== 'number') return
      const m = {
        avianBeforeInjection: row.avianBeforeInjection,
        avianAfter72Hours: row.avianAfter72Hours,
        bovineBeforeInjection: row.bovineBeforeInjection,
        bovineAfter72Hours: row.bovineAfter72Hours,
        avianOedema: row.avianOedema === 'SO' ? 'SO' : 'C',
        bovineOedema: row.bovineOedema === 'SO' ? 'SO' : 'C',
        reactorReference: row.reactorReference
      }
      // Calculated by the same TB64 rules engine the rest of the service
      // uses, so a result recorded here is identical to one recorded on
      // the table variant or the original measurement pages.
      const interpretation = v14Interpret(m)
      stored[i] = Object.assign({}, stored[i] || blankEntry(), {
        status: 'done',
        performedTest: 'SICCT',
        divaStatus: 'done',
        overallResult: interpretation
          ? sicctInterpretation.toLegacyOverallResult(interpretation.resultCode)
          : '',
        sicctInterpretation: interpretation
      }, m)
    })
    req.session.data.skinTestEntries = stored

    const completed = Array.isArray(req.session.data.completedSkinTestPhases)
      ? req.session.data.completedSkinTestPhases.slice()
      : []
    if (completed.indexOf(phase) === -1) completed.push(phase)
    req.session.data.completedSkinTestPhases = completed

    res.redirect(`/${version}/skin-test-untested-animals`)
  }

  // --- Add untested animals ---------------------------------------------
  const V15_UNTESTED_FIELDS = ['untestedEarTag', 'untestedReason', 'untestedReasonOther']

  function v15BlankUntested() {
    return { untestedEarTag: '', untestedReason: '', untestedReasonOther: '' }
  }

  function v15SavedUntested(req) {
    const reasons = req.session.data.skinTestUntestedReasons || {}
    const others = req.session.data.skinTestUntestedReasonOthers || {}
    return getUntestedAnimals(req).map(function (a) {
      return {
        untestedEarTag: a.officialId,
        untestedReason: reasons[a.officialId] || '',
        untestedReasonOther: others[a.officialId] || ''
      }
    })
  }

  function renderV15Untested(req, res, options) {
    options = options || {}
    v14SeedSession(req, res)
    const rows = options.rows || v15SavedUntested(req)
    if (!rows.length) rows.push(v15BlankUntested())
    res.render(`${version}/skin-test-untested-animals`, {
      rows: rows.map(function (row, i) {
        return Object.assign({}, row, {
          number: i + 1,
          errors: (options.rowErrors || [])[i] || {}
        })
      }),
      total: rows.length,
      reasons: V15_REASONS,
      suggestions: v15Suggestions(req),
      currentTestLabel: getCurrentReactorPhaseLabel(req),
      backHref: `/${version}/skin-test-reactions`,
      // See the note on the reactions page - Add and Remove reload, so
      // the page is told where focus belongs afterwards.
      focusRow: options.focusRow || null,
      focusAdd: !!options.focusAdd,
      errorSummary: options.errorSummary
    })
  }

  function handleV15Untested(req, res) {
    v14SeedSession(req, res)
    let rows = v15PostedRows(req, V15_UNTESTED_FIELDS)
    const action = v15Action(req)

    if (action.name === 'add') {
      rows.push(v15BlankUntested())
      return renderV15Untested(req, res, { rows: rows, focusRow: rows.length })
    }
    if (action.name === 'remove') {
      rows.splice(action.index, 1)
      if (!rows.length) rows.push(v15BlankUntested())
      return renderV15Untested(req, res, { rows: rows, focusAdd: true })
    }

    // An untested block is blank when neither the tag nor the reason has
    // been touched. "Other reason" text alone does not count as filled in.
    rows = rows.filter(function (row) {
      return !!(row.untestedEarTag || row.untestedReason)
    })

    const rowErrors = []
    const errorList = []
    const seen = new Map()
    let blocked = false

    rows.forEach(function (row, i) {
      const errors = {}
      const n = i + 1

      const match = v15MatchAnimal(req, row.untestedEarTag)
      if (!row.untestedEarTag) {
        errors.untestedEarTag = 'Enter the ear tag number'
      } else if (match === 'ambiguous') {
        errors.untestedEarTag = 'Enter more of the ear tag - more than one animal ends ' + row.untestedEarTag
      } else if (!match) {
        errors.untestedEarTag = 'No animal on this holding matches ' + row.untestedEarTag
      } else if (seen.has(match.officialId)) {
        errors.untestedEarTag = match.officialId + ' has already been added as animal ' + seen.get(match.officialId)
        errors.untestedEarTagSelfContained = true
      } else {
        seen.set(match.officialId, n)
        row.officialId = match.officialId
      }

      const valid = V15_REASONS.map(function (r) { return r.value })
      if (!row.untestedReason) {
        errors.untestedReason = 'Select why this animal was not tested'
      } else if (valid.indexOf(row.untestedReason) === -1) {
        errors.untestedReason = 'Select why this animal was not tested'
      } else if (row.untestedReason === 'other' && !row.untestedReasonOther) {
        errors.untestedReasonOther = 'Enter the reason this animal was not tested'
      }

      if (errors.untestedEarTag) {
        errorList.push({
          text: v15Summary({ text: errors.untestedEarTag, selfContained: errors.untestedEarTagSelfContained }, 'animal', n),
          href: '#untestedEarTag-' + n
        })
      }
      if (errors.untestedReason) {
        errorList.push({ text: errors.untestedReason + ' for animal ' + n, href: '#untestedReason-' + n })
      }
      if (errors.untestedReasonOther) {
        errorList.push({ text: errors.untestedReasonOther + ' for animal ' + n, href: '#untestedReasonOther-' + n })
      }

      if (Object.keys(errors).length) blocked = true
      rowErrors.push(errors)
    })

    // An animal cannot both react and be untested.
    const reactors = new Set(getReactorsForPhase(req, getCurrentReactorPhase(req)))
    rows.forEach(function (row, i) {
      if (!row.officialId || !reactors.has(row.officialId)) return
      rowErrors[i].untestedEarTag = row.officialId + ' has already been recorded as a reaction'
      errorList.push({
        text: row.officialId + ' has already been recorded as a reaction',
        href: '#untestedEarTag-' + (i + 1)
      })
      blocked = true
    })

    if (blocked) {
      return renderV15Untested(req, res, {
        rows: rows,
        rowErrors: rowErrors,
        errorSummary: { titleText: 'There is a problem', errorList: errorList }
      })
    }

    const untestedIds = []
    const reasons = {}
    const reasonOthers = {}
    rows.forEach(function (row) {
      untestedIds.push(row.officialId)
      reasons[row.officialId] = row.untestedReason
      if (row.untestedReason === 'other') reasonOthers[row.officialId] = row.untestedReasonOther
    })

    req.session.data.skinTestUntested = untestedIds
    req.session.data.skinTestUntestedReasons = reasons
    req.session.data.skinTestUntestedReasonOthers = reasonOthers
    req.session.data.currentUntestedIndex = 0

    // Everything the vet did not name is tested with no reaction. Writing
    // it out explicitly means check your answers and the confirmation see
    // exactly what they would have seen from the table variant.
    const statuses = {}
    const reactorSet = new Set(getReactorsForPhase(req, getCurrentReactorPhase(req)))
    const untestedSet = new Set(untestedIds)
    getReportingAnimalsWithFlags(req).forEach(function (a) {
      statuses[a.officialId] = reactorSet.has(a.officialId)
        ? 'reaction'
        : (untestedSet.has(a.officialId) ? 'not-tested' : 'clear')
    })
    req.session.data.skinTestReviewStatuses = statuses

    res.redirect(`/${version}/skin-test-add-cattle-question`)
  }

  if (version === 'v1-5') {
    router.get(`/${version}/skin-test-reactions`, function (req, res) {
      renderV15Reactions(req, res)
    })
    router.post(`/${version}/skin-test-reactions`, handleV15Reactions)

    router.get(`/${version}/skin-test-untested-animals`, function (req, res) {
      renderV15Untested(req, res)
    })
    router.post(`/${version}/skin-test-untested-animals`, handleV15Untested)

    // The table variant's entry point, and the pages this variant
    // replaces, all land on the reactions page instead.
    ;['skin-test-reactors', 'skin-test-reactors-any', 'skin-test-table',
      'skin-test-measurements', 'skin-test-untested', 'skin-test-untested-reason',
      'skin-test-all-tested', 'skin-test-record-first', 'skin-test-type',
      'skin-test-date', 'skin-test-batch-details', 'skin-test-diluent-details',
      'skin-test-confirm-test', 'skin-test-list'].forEach(function (path) {
      router.all(`/${version}/${path}`, function (req, res) {
        res.redirect(`/${version}/skin-test-reactions`)
      })
    })
  }

  // --- Step 1: decision page – "Did any cattle react?" -----------------
  // Splits the high-level decision out of the long selection list, so
  // the vet only sees the cattle table when they've already said "Yes".
  // For the "Both" journey the page is shown twice – once per test –
  // so the caption / heading reflects the current test (SICCT or DIVA).
  router.get(`/${version}/skin-test-reactors-any`, function (req, res) {
    // v1-4 retires this gate – the review table records "no reaction"
    // as an explicit status, so there is nothing left to ask here.
    if (isV14Review(req)) {
      return res.redirect(`/${version}/skin-test-reactors`)
    }
    const perTest = isPerTestSubFlow(req)
    const phase = perTest ? req.session.data.currentSkinTest : getCurrentReactorPhase(req)
    const phaseLabel = phase === 'diva' ? 'DIVA' : 'SICCT'
    const isBoth = req.session.data.skinTestType === 'Both'
    // In the per-test sub-flow the question is scoped to the active
    // test, so the combined-Both heading does NOT apply.
    const isCombinedBoth = isBoth && (version === 'v1-2' || isV13Plus(version)) && !perTest
    res.render(`${version}/skin-test-reactors-any`, {
      currentReactorPhase: phase,
      currentTestLabel: phaseLabel,
      isBothJourney: isBoth,
      isCombinedBoth
    })
  })

  router.post(`/${version}/skin-test-reactors-any`, function (req, res) {
    const perTest = isPerTestSubFlow(req)
    const phase = perTest ? req.session.data.currentSkinTest : getCurrentReactorPhase(req)
    const phaseLabel = phase === 'diva' ? 'DIVA' : 'SICCT'
    const isBoth = req.session.data.skinTestType === 'Both'
    // The combined-Both shortcut only applies when we're NOT in the
    // per-test sub-flow. Once currentSkinTest is set the answer is
    // scoped to that test only.
    const isCombinedBoth = isBoth && (version === 'v1-2' || isV13Plus(version)) && !perTest
    const anyReactors = req.body.anyReactors

    const anyReactorsByPhase = Object.assign({}, req.session.data.anyReactorsByPhase || {})
    anyReactorsByPhase[phase] = anyReactors
    if (isCombinedBoth) {
      anyReactorsByPhase[phase === 'sicct' ? 'diva' : 'sicct'] = anyReactors
    }
    req.session.data.anyReactorsByPhase = anyReactorsByPhase
    req.session.data.anyReactors = anyReactors

    if (anyReactors !== 'yes' && anyReactors !== 'no') {
      return res.render(`${version}/skin-test-reactors-any`, {
        currentReactorPhase: phase,
        currentTestLabel: phaseLabel,
        isBothJourney: isBoth,
        isCombinedBoth,
        errors: { anyReactors: { text: 'Select yes if any cattle reacted, or no if none reacted' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select yes if any cattle reacted, or no if none reacted', href: '#anyReactors' }]
        }
      })
    }

    if (anyReactors === 'no') {
      setReactorsForPhase(req, phase, [])
      if (isCombinedBoth) {
        setReactorsForPhase(req, phase === 'sicct' ? 'diva' : 'sicct', [])
      }

      const allEntries = getEntries(req)
      const stored = Array.isArray(req.session.data.skinTestEntries)
        ? [...req.session.data.skinTestEntries]
        : []
      while (stored.length < allEntries.length) stored.push(blankEntry())
      req.session.data.skinTestEntries = stored

      const completed = Array.isArray(req.session.data.completedSkinTestPhases)
        ? req.session.data.completedSkinTestPhases.slice()
        : []
      if (completed.indexOf(phase) === -1) completed.push(phase)
      if (isCombinedBoth) {
        const otherPhase = phase === 'sicct' ? 'diva' : 'sicct'
        if (completed.indexOf(otherPhase) === -1) completed.push(otherPhase)
      }
      req.session.data.completedSkinTestPhases = completed

      // Per-test sub-flow: skip straight to the per-test confirm page
      // (which then loops back to the other test or to all-tested).
      if (perTest) {
        return res.redirect(`/${version}/skin-test-confirm-test/${phase}`)
      }

      if (isBoth && !isCombinedBoth) {
        const otherPhase = phase === 'sicct' ? 'diva' : 'sicct'
        if (completed.indexOf(otherPhase) === -1) {
          return res.redirect(`/${version}/skin-test-reactors-any`)
        }
      }

      return res.redirect(`/${version}/skin-test-all-tested`)
    }

    // "Yes" → carry on to the cattle selection step.
    res.redirect(`/${version}/skin-test-reactors`)
  })

  // --- Step 2: selection page – "Which cattle reacted?" ----------------
  router.get(`/${version}/skin-test-reactors`, function (req, res) {
    // v1-4 serves the single-pass review table at this URL instead of
    // the reactor-only multi-select.
    if (isV14Review(req)) {
      return renderV14Review(req, res)
    }
    // v1-3 can be entered straight at the tick list, the same way v1-4
    // can be entered at its review table, so a research session can drop
    // someone into either journey without walking the pages in front of
    // it. Seeds the farm, the test and the dates the skipped pages would
    // have set.
    //
    // "Did any cattle react?" is answered yes, because a vet who has
    // been sent to the list of cattle to tick has already been asked.
    // Only when it has not been answered - someone who came through the
    // journey and said no still goes back to that page, which is the
    // whole point of the gate.
    if (version === 'v1-3') {
      v14SeedSession(req, res)
      const entryPhase = getCurrentReactorPhase(req)
      const answered = req.session.data.anyReactorsByPhase || {}
      if (!answered[entryPhase]) {
        const next = Object.assign({}, answered)
        next[entryPhase] = 'yes'
        req.session.data.anyReactorsByPhase = next
        req.session.data.anyReactors = 'yes'
        if (res && res.locals) {
          res.locals.data = Object.assign({}, res.locals.data || {}, {
            anyReactorsByPhase: next,
            anyReactors: 'yes'
          })
        }
      }
    }
    const perTest = isPerTestSubFlow(req)
    const phase = perTest ? req.session.data.currentSkinTest : getCurrentReactorPhase(req)
    const phaseLabel = phase === 'diva' ? 'DIVA' : 'SICCT'
    const isBoth = req.session.data.skinTestType === 'Both'
    const isCombinedBoth = isBoth && (version === 'v1-2' || isV13Plus(version)) && !perTest
    const anyReactorsByPhase = req.session.data.anyReactorsByPhase || {}

    // Skip straight back to the decision page if the vet hasn't
    // answered the high-level question for this phase yet.
    if (anyReactorsByPhase[phase] !== 'yes') {
      return res.redirect(`/${version}/skin-test-reactors-any`)
    }
    let animals = getReportingAnimalsWithFlags(req)
    // Per-test sub-flow: scope the picker to only the animals that
    // sit on this test's prepared list (SICCT = unvaccinated, DIVA =
    // vaccinated, via prepareSkinTestAssignments).
    if (perTest) {
      const allowed = getPerTestAnimalIdSet(req, phase)
      // Fall back to no filtering when the assignment set is empty
      // (single-test CPHs don't populate prepareSkinTestAssignments).
      if (allowed.size > 0) {
        animals = animals.filter(function (a) { return allowed.has(a.officialId) })
      }
    }
    if (!animals.length) {
      return res.redirect(`/${version}/skin-test-type`)
    }
    // For v1-2 Both we show one combined picker covering both tests,
    // so the pre-ticked set is the union of the SICCT and DIVA reactor
    // lists (typically empty on first visit). Per-test sub-flow uses
    // the current phase only.
    const selectedReactors = isCombinedBoth
      ? Array.from(new Set([
          ...getReactorsForPhase(req, 'sicct'),
          ...getReactorsForPhase(req, 'diva')
        ]))
      : getReactorsForPhase(req, phase)

    // When a list has been prepared for this farm we surface the
    // prepared-list sort so the filter panel matches the order the
    // animals are actually displayed in.
    const cph = req.session.data.herd && req.session.data.herd.cph
    const preparedRecords = Array.isArray(req.session.data.skinTestListPrepared)
      ? req.session.data.skinTestListPrepared
      : []
    const hasPreparedList = !!cph && preparedRecords.some(function (r) {
      return r && r.cph === cph
    })
    const sortByForFilter = hasPreparedList
      ? (req.session.data.skinTestSortBy
        || req.session.data.prepareSkinTestUntestedSortBy
        || 'Ear-tag number (last 5 digits)')
      : (req.session.data.prepareSkinTestUntestedSortBy
        || 'Ear-tag number (last 5 digits)')
    const sortDirectionForFilter = hasPreparedList
      ? (req.session.data.skinTestSortDirection
        || req.session.data.prepareSkinTestUntestedSortDirection
        || 'asc')
      : (req.session.data.prepareSkinTestUntestedSortDirection || 'asc')

    res.render(`${version}/skin-test-reactors`, {
      animals,
      selectedReactors,
      currentReactorPhase: phase,
      currentTestLabel: phaseLabel,
      isBothJourney: isBoth,
      isCombinedBoth,
      sortBy: sortByForFilter,
      sortDirection: sortDirectionForFilter
    })
  })

  // List-settings POST – persist the chosen sort + direction and bounce
  // back to the reactor page. The vet's existing tick state is left
  // alone (it's stored separately under skinTestReactors).
  router.post(`/${version}/skin-test-reactors/settings`, function (req, res) {
    req.session.data.prepareSkinTestUntestedSortBy = req.body.sortBy || 'Ear-tag number (last 5 digits)'
    req.session.data.prepareSkinTestUntestedSortDirection = req.body.sortDirection || 'asc'
    res.redirect(`/${version}/skin-test-reactors`)
  })

  router.get(`/${version}/skin-test-reactors/settings/reset`, function (req, res) {
    req.session.data.prepareSkinTestUntestedSortBy = 'Ear-tag number (last 5 digits)'
    req.session.data.prepareSkinTestUntestedSortDirection = 'asc'
    res.redirect(`/${version}/skin-test-reactors`)
  })

  // "None of these cattle" skip link on the reactors page. The vet has
  // landed here after answering "Yes" on skin-test-reactors-any but has
  // changed their mind – this acts the same as answering "No" on the
  // gate page: clears reactors for the current phase, marks the phase
  // complete, and routes onward (to the other phase for Both, or to
  // the all-tested gate).
  router.post(`/${version}/skin-test-reactors/skip`, function (req, res) {
    const perTest = isPerTestSubFlow(req)
    const phase = perTest ? req.session.data.currentSkinTest : getCurrentReactorPhase(req)
    const isBoth = req.session.data.skinTestType === 'Both'
    const isCombinedBoth = isBoth && (version === 'v1-2' || isV13Plus(version)) && !perTest

    setReactorsForPhase(req, phase, [])
    if (isCombinedBoth) {
      setReactorsForPhase(req, phase === 'sicct' ? 'diva' : 'sicct', [])
    }

    const anyReactorsByPhase = Object.assign({}, req.session.data.anyReactorsByPhase || {})
    anyReactorsByPhase[phase] = 'no'
    if (isCombinedBoth) {
      anyReactorsByPhase[phase === 'sicct' ? 'diva' : 'sicct'] = 'no'
    }
    req.session.data.anyReactorsByPhase = anyReactorsByPhase
    req.session.data.anyReactors = 'no'

    const allEntries = getEntries(req)
    const stored = Array.isArray(req.session.data.skinTestEntries)
      ? [...req.session.data.skinTestEntries]
      : []
    while (stored.length < allEntries.length) stored.push(blankEntry())
    req.session.data.skinTestEntries = stored

    const completed = Array.isArray(req.session.data.completedSkinTestPhases)
      ? req.session.data.completedSkinTestPhases.slice()
      : []
    if (completed.indexOf(phase) === -1) completed.push(phase)
    if (isCombinedBoth) {
      const otherPhase = phase === 'sicct' ? 'diva' : 'sicct'
      if (completed.indexOf(otherPhase) === -1) completed.push(otherPhase)
    }
    req.session.data.completedSkinTestPhases = completed

    // Per-test sub-flow: head to the per-test confirm page – the
    // routing helper there decides whether to loop back for the
    // other test or to continue to all-tested.
    if (perTest) {
      return res.redirect(`/${version}/skin-test-confirm-test/${phase}`)
    }

    if (isBoth && !isCombinedBoth) {
      const otherPhase = phase === 'sicct' ? 'diva' : 'sicct'
      if (completed.indexOf(otherPhase) === -1) {
        return res.redirect(`/${version}/skin-test-reactors-any`)
      }
    }

    res.redirect(`/${version}/skin-test-all-tested`)
  })

  router.post(`/${version}/skin-test-reactors`, function (req, res) {
    if (isV14Review(req)) {
      return handleV14Review(req, res)
    }
    const perTest = isPerTestSubFlow(req)
    const phase = perTest ? req.session.data.currentSkinTest : getCurrentReactorPhase(req)
    const phaseLabel = phase === 'diva' ? 'DIVA' : 'SICCT'
    const isBoth = req.session.data.skinTestType === 'Both'
    const isCombinedBoth = isBoth && (version === 'v1-2' || isV13Plus(version)) && !perTest

    // Filter the Prototype Kit's "_unchecked" placeholder so an empty
    // submission really registers as zero reactors.
    const submittedReactors = Array.isArray(req.body.reactors)
      ? req.body.reactors
      : (req.body.reactors ? [req.body.reactors] : [])
    const reactors = submittedReactors.filter(function (id) {
      return id && id !== '_unchecked'
    })

    // Validation: the vet has already answered "Yes" on the previous
    // step, so they must tick at least one animal here. If they want
    // to record no reactors, they go back and select "No".
    if (reactors.length === 0) {
      let animals = getReportingAnimalsWithFlags(req)
      if (perTest) {
        const allowed = getPerTestAnimalIdSet(req, phase)
        if (allowed.size > 0) {
          animals = animals.filter(function (a) { return allowed.has(a.officialId) })
        }
      }
      return res.render(`${version}/skin-test-reactors`, {
        animals,
        selectedReactors: [],
        currentReactorPhase: phase,
        currentTestLabel: phaseLabel,
        isBothJourney: isBoth,
        isCombinedBoth,
        errors: { reactors: { text: 'Select at least one animal that reacted' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select at least one animal that reacted', href: '#reactor-1' }]
        }
      })
    }

    // For v1-2 Both (legacy combined path), ALL reactors loop through
    // the unified measurement page (skin-test-diva). The vet picks
    // SICCT or DIVA per animal on that page. This branch is bypassed
    // entirely when we're in the per-test sub-flow.
    if (isCombinedBoth) {
      setReactorsForPhase(req, 'sicct', [])
      setReactorsForPhase(req, 'diva', reactors)

      req.session.data.currentSkinTestIndex = 0
      req.session.data.currentDivaIndex = 0

      const completed = Array.isArray(req.session.data.completedSkinTestPhases)
        ? req.session.data.completedSkinTestPhases.slice()
        : []
      if (completed.indexOf('sicct') === -1) completed.push('sicct')
      req.session.data.completedSkinTestPhases = completed

      // Seed blank entries so each reactor has a row ready when the
      // measurement screens write back.
      const allEntries = getEntries(req)
      const stored = Array.isArray(req.session.data.skinTestEntries)
        ? [...req.session.data.skinTestEntries]
        : []
      while (stored.length < allEntries.length) stored.push(blankEntry())
      req.session.data.skinTestEntries = stored

      req.session.data.currentSkinTestPhase = 'diva'
      return res.redirect(`/${version}/skin-test-diva/0`)
    }

    setReactorsForPhase(req, phase, reactors)

    // Reset the measurement pointer for this phase only so the loop
    // starts at the first reactor.
    if (phase === 'diva') {
      req.session.data.currentDivaIndex = 0
    } else {
      req.session.data.currentSkinTestIndex = 0
    }

    // Seed blank entries so each reactor has a row ready when the
    // measurement screens write back.
    const allEntries = getEntries(req)
    const stored = Array.isArray(req.session.data.skinTestEntries)
      ? [...req.session.data.skinTestEntries]
      : []
    while (stored.length < allEntries.length) stored.push(blankEntry())
    req.session.data.skinTestEntries = stored

    // Per-test sub-flow (v1-2): head straight to the bulk
    // measurement table for the active phase.
    if (perTest && (version === 'v1-2' || isV13Plus(version))) {
      req.session.data.currentSkinTestPhase = phase
      return res.redirect(`/${version}/${testTablePath}`)
    }

    // Routing: head into the measurement loop for this phase.
    if (phase === 'diva') {
      req.session.data.currentSkinTestPhase = 'diva'
      return res.redirect(`/${version}/skin-test-diva/0`)
    }
    req.session.data.currentSkinTestPhase = 'sicct'
    res.redirect(`/${version}/skin-test-measurements/0`)
  })

  // --- "Were all of the cattle tested?" gate page -----------------------
  // Sits between the reactor flow and the mark-untested page so the vet
  // doesn't have to scan the long animal table when every cow was
  // actually tested.
  router.get(`/${version}/skin-test-all-tested`, function (req, res) {
    // v1-4 retires this gate too – "not tested" is a status on the review
    // table, so every animal is already accounted for by the time the vet
    // gets here. The measurement journey still exits to this URL, so it
    // stays registered and forwards straight on to the next real step.
    if (isV14Review(req)) {
      return res.redirect(v14AfterReviewHref(req))
    }
    // Show the same animal list (and order) that the vet prepared for
    // this farm, so the "were all tested?" question has the herd they
    // worked from sat above the radios.
    const baseAnimals = getReportingAnimalsWithFlags(req)
    // Annotate each animal with an `isReactor` flag so the table can
    // mark reactors with a visible badge. v1-2 unifies SICCT and DIVA
    // reactors into a single column because the page is shown after
    // the vet has finished both phases.
    const reactorIdSet = new Set([
      ...getReactorsForPhase(req, 'sicct'),
      ...getReactorsForPhase(req, 'diva')
    ])
    // For Both journeys, surface which prepared list each animal sat
    // on so the all-tested list reflects the two-list reporting. Reads
    // from the manual / auto assignments populated in the prepare flow.
    const isBoth = req.session.data.skinTestType === 'Both'
    const sicctIds = isBoth ? getPerTestAnimalIdSet(req, 'sicct') : new Set()
    const divaIds = isBoth ? getPerTestAnimalIdSet(req, 'diva') : new Set()
    const animals = baseAnimals.map(function (a) {
      let assignedTest = null
      if (isBoth) {
        if (sicctIds.has(a.officialId)) assignedTest = 'SICCT'
        else if (divaIds.has(a.officialId)) assignedTest = 'DIVA'
      }
      return Object.assign({}, a, {
        isReactor: reactorIdSet.has(a.officialId),
        assignedTest: assignedTest
      })
    })
    // Surface the active sort to the filter panel. Prefer the
    // prepared-list keys (skinTestSortBy / Direction) when set – they
    // are what getReportingAnimalsWithFlags applies when a list has
    // been prepared. Otherwise fall back to the picker keys used by
    // the reactor / mark-untested pages.
    const sortBy = req.session.data.skinTestSortBy
      || req.session.data.prepareSkinTestUntestedSortBy
      || 'Ear-tag number (last 5 digits)'
    const sortDirection = req.session.data.skinTestSortDirection
      || req.session.data.prepareSkinTestUntestedSortDirection
      || 'asc'
    const pageSize = 25
    const currentPage = Math.max(1, parseInt(req.query.page, 10) || 1)
    res.render(`${version}/skin-test-all-tested`, {
      animals,
      totalCattle: animals.length,
      isBothJourney: isBoth,
      sortBy,
      sortDirection,
      pageSize,
      currentPage
    })
  })

  // List-settings POST – persist the chosen sort + direction and bounce
  // back to the all-tested page so applying a new sort doesn't disturb
  // the radio selection. We write to both the prepared-list keys and
  // the picker keys so the choice carries across however the order is
  // resolved downstream.
  router.post(`/${version}/skin-test-all-tested/settings`, function (req, res) {
    const sortBy = req.body.sortBy || 'Ear-tag number (last 5 digits)'
    const sortDirection = req.body.sortDirection || 'asc'
    req.session.data.skinTestSortBy = sortBy
    req.session.data.skinTestSortDirection = sortDirection
    req.session.data.prepareSkinTestUntestedSortBy = sortBy
    req.session.data.prepareSkinTestUntestedSortDirection = sortDirection
    res.redirect(`/${version}/skin-test-all-tested`)
  })

  router.get(`/${version}/skin-test-all-tested/settings/reset`, function (req, res) {
    req.session.data.skinTestSortBy = 'Ear-tag number (last 5 digits)'
    req.session.data.skinTestSortDirection = 'asc'
    req.session.data.prepareSkinTestUntestedSortBy = 'Ear-tag number (last 5 digits)'
    req.session.data.prepareSkinTestUntestedSortDirection = 'asc'
    res.redirect(`/${version}/skin-test-all-tested`)
  })

  router.post(`/${version}/skin-test-all-tested`, function (req, res) {
    const allCattleTestedReport = req.body.allCattleTestedReport
    req.session.data.allCattleTestedReport = allCattleTestedReport

    if (allCattleTestedReport !== 'yes' && allCattleTestedReport !== 'no') {
      const animals = getReportingAnimalsWithFlags(req)
      const sortBy = req.session.data.skinTestSortBy
        || req.session.data.prepareSkinTestUntestedSortBy
        || 'Ear-tag number (last 5 digits)'
      const sortDirection = req.session.data.skinTestSortDirection
        || req.session.data.prepareSkinTestUntestedSortDirection
        || 'asc'
      const pageSize = 25
      const currentPage = Math.max(1, parseInt(req.query.page, 10) || 1)
      return res.render(`${version}/skin-test-all-tested`, {
        animals,
        totalCattle: animals.length,
        sortBy,
        sortDirection,
        pageSize,
        currentPage,
        errors: { allCattleTestedReport: { text: 'Select yes if all cattle were tested, or no if some were not' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select yes if all cattle were tested, or no if some were not', href: '#allCattleTestedReport' }]
        }
      })
    }

    if (allCattleTestedReport === 'yes') {
      // Every animal tested – clear any prior untested state and
      // skip the mark-untested page entirely. v1-2 routes through
      // the "are there more cattle to add?" question before review;
      // v1-1 goes straight to the review page.
      req.session.data.skinTestUntested = []
      req.session.data.skinTestUntestedReasons = {}
      req.session.data.skinTestUntestedReasonOthers = {}
      if ((version === 'v1-2' || isV13Plus(version))) {
        return res.redirect(`/${version}/skin-test-add-cattle-question`)
      }
      return res.redirect(`/${version}/skin-test-confirmation`)
    }

    res.redirect(`/${version}/skin-test-untested`)
  })

  // --- Untested picker --------------------------------------------------
  // After the reactor loop, the vet ticks any remaining animals that
  // were not tested on this visit and picks a reason for each. Any
  // animal left unticked is treated as a "clear" (negative) result.
  router.get(`/${version}/skin-test-untested`, function (req, res) {
    // v1-4 collects the untested cattle on the review table, so this
    // second pass over the herd is skipped entirely.
    if (isV14Review(req)) {
      return res.redirect(v14AfterReviewHref(req))
    }
    // getReportingAnimalsWithFlags already applies the user's chosen
    // sort (it reads prepareSkinTestUntestedSortBy / Direction), so
    // the table is ordered by the time we filter out reactors below.
    const allAnimals = getReportingAnimalsWithFlags(req)
    const sicctReactorIds = getReactorsForPhase(req, 'sicct')
    const divaReactorIds = getReactorsForPhase(req, 'diva')
    const reactorSet = new Set([...sicctReactorIds, ...divaReactorIds])
    const remainingBase = allAnimals.filter(function (a) { return !reactorSet.has(a.officialId) })

    // Eligibility flags. The list is "cattle that were eligible for
    // testing but were not fully tested", so cattle that were never
    // eligible are flagged with the reason. They stay selectable (a data
    // error might mean one really was tested), but the flag steers the
    // vet away from marking an animal that never should have been tested.
    //   - Too young: under the 42-day minimum skin-test age.
    //   - Tested elsewhere: tested on another farm within the last 60
    //     days (mirrors the frequent-flyer marker on the printed list,
    //     derived from a stable hash of the ear tag). A real service
    //     would read this from CTS test history.
    const phase = getCurrentReactorPhase(req)
    const remaining = remainingBase.map(function (a) {
      const days = ageInMonthsFromDob(a.dob)
      const isTooYoung = typeof days === 'number' && days >= 0 && days < 42
      const recent = recentTestFor(a, phase, version === 'v1-4' || version === 'v1-5')
      let ineligibleReason = ''
      let ineligibleDetail = ''
      if (isTooYoung) {
        ineligibleReason = 'Too young to test'
        ineligibleDetail = 'Under the minimum testing age of 42 days.'
      } else if (recent) {
        ineligibleReason = 'Tested on another farm'
        ineligibleDetail = 'Last ' + (recent.type || 'SICCT') + ' test ' + recent.date
          + ', within the 60-day minimum interval.'
      }
      return Object.assign({}, a, {
        isTooYoung: isTooYoung,
        testedElsewhereRecently: !!recent,
        recentTestDate: recent ? recent.date : '',
        recentTestType: recent ? (recent.type || 'SICCT') : '',
        ineligible: !!ineligibleReason,
        ineligibleReason: ineligibleReason,
        ineligibleDetail: ineligibleDetail
      })
    })
    const selectedUntested = Array.isArray(req.session.data.skinTestUntested)
      ? req.session.data.skinTestUntested
      : []
    const untestedReasons = req.session.data.skinTestUntestedReasons || {}

    // Back link always returns to the "were all of the cattle tested?"
    // gate, so the vet can flip Yes/No without juggling state.
    const backHref = `/${version}/skin-test-all-tested`

    res.render(`${version}/skin-test-untested`, {
      animals: remaining,
      selectedUntested,
      untestedReasons,
      backHref,
      sortBy: req.session.data.prepareSkinTestUntestedSortBy || 'Ear-tag number (last 5 digits)',
      sortDirection: req.session.data.prepareSkinTestUntestedSortDirection || 'asc'
    })
  })

  // List-settings POST – persists the chosen sort to the same session
  // keys used on prepare-skin-test-untested + skin-test-reactors, so
  // the vet's preference carries across the whole journey.
  router.post(`/${version}/skin-test-untested/settings`, function (req, res) {
    req.session.data.prepareSkinTestUntestedSortBy = req.body.sortBy || 'Ear-tag number (last 5 digits)'
    req.session.data.prepareSkinTestUntestedSortDirection = req.body.sortDirection || 'asc'
    res.redirect(`/${version}/skin-test-untested`)
  })

  router.get(`/${version}/skin-test-untested/settings/reset`, function (req, res) {
    req.session.data.prepareSkinTestUntestedSortBy = 'Ear-tag number (last 5 digits)'
    req.session.data.prepareSkinTestUntestedSortDirection = 'asc'
    res.redirect(`/${version}/skin-test-untested`)
  })

  router.post(`/${version}/skin-test-untested`, function (req, res) {
    // The Prototype Kit injects a "_unchecked" placeholder when a
    // checkbox group is submitted empty. Filter it out so an empty
    // submission cleanly routes to the confirmation step (every
    // remaining animal stays marked as clear) rather than into the
    // reason loop with a non-existent id.
    const submitted = Array.isArray(req.body.untested)
      ? req.body.untested
      : (req.body.untested ? [req.body.untested] : [])
    const untested = submitted.filter(function (id) {
      return id && id !== '_unchecked'
    })

    req.session.data.skinTestUntested = untested

    // Prune any stale reasons for animals that are no longer ticked as
    // untested (for example, the vet unticked one on this visit).
    const existingReasons = req.session.data.skinTestUntestedReasons || {}
    const existingOthers = req.session.data.skinTestUntestedReasonOthers || {}
    const prunedReasons = {}
    const prunedOthers = {}
    untested.forEach(function (id) {
      if (existingReasons[id]) prunedReasons[id] = existingReasons[id]
      if (existingOthers[id]) prunedOthers[id] = existingOthers[id]
    })
    req.session.data.skinTestUntestedReasons = prunedReasons
    req.session.data.skinTestUntestedReasonOthers = prunedOthers
    req.session.data.currentUntestedIndex = 0

    // Nothing ticked – every remaining animal is clear. Skip the
    // per-animal reason loop. v1-3 still offers "Are there more cattle
    // to add?" before review (matching the all-tested = "yes" path);
    // older versions go straight to the review page.
    if (untested.length === 0) {
      if (isV13Plus(version)) {
        return res.redirect(`/${version}/skin-test-add-cattle-question`)
      }
      return res.redirect(`/${version}/skin-test-confirmation`)
    }

    // Go to the reasons step. v1-3 uses the bulk select page; older
    // versions iterate the ticked cattle one at a time.
    if (isV13Plus(version)) {
      return res.redirect(`/${version}/skin-test-untested-reason`)
    }
    res.redirect(`/${version}/skin-test-untested-reason/0`)
  })

  // --- Untested reason loop --------------------------------------------
  // One page per ticked animal. The vet picks a reason ("not found",
  // "deceased", "withdrawn for export", etc.) and moves on to the next
  // until every untested animal has a reason recorded.
  function getUntestedAnimals(req) {
    const untestedIds = Array.isArray(req.session.data.skinTestUntested)
      ? req.session.data.skinTestUntested
      : []
    if (untestedIds.length === 0) return []
    const untestedSet = new Set(untestedIds)
    return getReportingAnimalsWithFlags(req).filter(function (a) {
      return untestedSet.has(a.officialId)
    })
  }

  function renderUntestedReason(req, res, index, options) {
    const untestedAnimals = getUntestedAnimals(req)
    const total = untestedAnimals.length
    if (total === 0) return res.redirect(`/${version}/skin-test-untested`)

    const safeIndex = Math.max(0, Math.min(index, total - 1))
    const currentAnimal = untestedAnimals[safeIndex]
    const reasons = req.session.data.skinTestUntestedReasons || {}
    const others = req.session.data.skinTestUntestedReasonOthers || {}

    // Progress counts only completed entries (those with a reason set).
    const completedCount = untestedAnimals.filter(function (a) { return reasons[a.officialId] }).length
    const progressPercent = total > 0 ? Math.round((completedCount / total) * 100) : 0

    const backHref = safeIndex > 0
      ? `/${version}/skin-test-untested-reason/${safeIndex - 1}`
      : `/${version}/skin-test-untested`

    res.render(`${version}/skin-test-untested-reason`, {
      currentIndex: safeIndex,
      currentPosition: safeIndex + 1,
      totalUntested: total,
      completedCount,
      remainingCount: total - completedCount,
      progressPercent,
      currentAnimal: Object.assign({}, currentAnimal, {
        dob: currentAnimal.dob,
        sex: currentAnimal.sex,
        breed: currentAnimal.breed
      }),
      savedReason: reasons[currentAnimal.officialId] || '',
      savedReasonOther: others[currentAnimal.officialId] || '',
      backHref,
      errors: options && options.errors,
      errorSummary: options && options.errorSummary,
      formValues: (options && options.formValues) || {}
    })
  }

  // v1-3: bulk reason capture, modelled on /select-vaccinated-animals.
  // The vet ticks a group of untested cattle, picks one reason and marks
  // them; marked cattle drop off the remaining list. Repeat until none
  // remain. v1-1 / v1-2 keep the one-at-a-time wizard (the /:index routes
  // below).
  function renderUntestedReasons(req, res, options) {
    options = options || {}
    const untestedAnimals = getUntestedAnimals(req)
    const reasons = req.session.data.skinTestUntestedReasons || {}
    const remaining = untestedAnimals.filter(function (a) { return !reasons[a.officialId] })
    res.render(`${version}/skin-test-untested-reason`, {
      remainingAnimals: remaining,
      // "Add reason now" on the review table sends the vet here with one
      // animal already ticked, so recording a single reason is choosing a
      // reason and pressing the button - nothing else to hunt for.
      preselectAnimal: (req.query && req.query.animal) || '',
      totalUntested: untestedAnimals.length,
      remainingCount: remaining.length,
      markedCount: untestedAnimals.length - remaining.length,
      errors: options.errors,
      errorSummary: options.errorSummary,
      formValues: options.formValues || {}
    })
  }

  router.get(`/${version}/skin-test-untested-reason`, function (req, res) {
    const untestedAnimals = getUntestedAnimals(req)
    if (untestedAnimals.length === 0) {
      return res.redirect(`/${version}/skin-test-untested`)
    }
    // Older versions keep the one-at-a-time wizard, resuming where the
    // vet left off.
    if (!isV13Plus(version)) {
      const resumeIndex = Number.isInteger(req.session.data.currentUntestedIndex)
        ? req.session.data.currentUntestedIndex
        : 0
      return res.redirect(`/${version}/skin-test-untested-reason/${resumeIndex}`)
    }
    // v1-3 bulk page. Once every untested animal has a reason, continue.
    const reasons = req.session.data.skinTestUntestedReasons || {}
    const remaining = untestedAnimals.filter(function (a) { return !reasons[a.officialId] })
    if (remaining.length === 0) {
      return res.redirect(`/${version}/skin-test-add-cattle-question`)
    }
    renderUntestedReasons(req, res)
  })

  // Reasons that leave the herd's test incomplete, so the report is filed
  // as a part test with animals still to test.
  //
  // The rule is one question: does this animal still need testing? Only
  // two reasons close it - the animal is dead, or it was never eligible
  // for this test in the first place. Everything else, including "other",
  // leaves it open. "Other" counts because an unknown reason cannot be
  // assumed to mean the animal never needs testing again; the safe
  // default is that it does.
  //
  // v1-0 to v1-3 values: "Could not be managed" (return-visit) and
  // "Missing on day 2" (injected on Day 1 but not read, so must be
  // re-tested after 60 days). V5 values follow. The two sets are disjoint,
  // so no version check is needed - an older version can never post a V5
  // value, or the other way round.
  const STILL_TO_TEST_REASONS = [
    'return-visit', 'could-not-read-day-2',
    'not-presented', 'not-possible', 'other'
  ]

  function isStillToTestReason(reason) {
    return STILL_TO_TEST_REASONS.indexOf(reason) !== -1
  }

  // Where to go once every untested animal has a reason. If any leave the
  // herd test incomplete (see isStillToTestReason) the herd test is not
  // finished, so route through the part-test explainer; otherwise carry on
  // to the add-cattle question.
  function untestedReasonsDoneHref(req) {
    const reasons = req.session.data.skinTestUntestedReasons || {}
    const hasStillToTest = Object.keys(reasons).some(function (id) { return isStillToTestReason(reasons[id]) })
    return hasStillToTest
      ? `/${version}/skin-test-part-test`
      : `/${version}/skin-test-add-cattle-question`
  }

  // v1-3 bulk POST: assign one reason to the ticked cattle.
  router.post(`/${version}/skin-test-untested-reason`, function (req, res) {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/skin-test-untested-reason`)
    }
    const untestedAnimals = getUntestedAnimals(req)
    if (untestedAnimals.length === 0) {
      return res.redirect(`/${version}/skin-test-untested`)
    }
    const untestedSet = new Set(untestedAnimals.map(function (a) { return a.officialId }))
    const reasons = Object.assign({}, req.session.data.skinTestUntestedReasons || {})
    const others = Object.assign({}, req.session.data.skinTestUntestedReasonOthers || {})

    // "Skip and mark as no reason given" – bulk-mark every remaining
    // untested animal and continue.
    if (req.body.markAction === 'skip-no-reason') {
      untestedAnimals.forEach(function (a) {
        if (!reasons[a.officialId]) { reasons[a.officialId] = 'no-reason'; delete others[a.officialId] }
      })
      req.session.data.skinTestUntestedReasons = reasons
      req.session.data.skinTestUntestedReasonOthers = others
      return res.redirect(untestedReasonsDoneHref(req))
    }

    const selectedIds = (Array.isArray(req.body.selectedAnimals)
      ? req.body.selectedAnimals
      : (req.body.selectedAnimals ? [req.body.selectedAnimals] : []))
      .filter(function (id) { return id && id !== '_unchecked' && untestedSet.has(id) })
    const reason = (req.body.reason || '').trim()
    const reasonOther = (req.body.reasonOther || '').trim()

    const errors = {}
    const errorList = []
    if (selectedIds.length === 0) {
      errors.selectedAnimals = { text: 'Select the cattle this reason applies to' }
      errorList.push({ text: 'Select the cattle this reason applies to', href: '#selected-animals' })
    }
    if (!reason) {
      errors.reason = { text: 'Select a reason these cattle were not tested' }
      errorList.push({ text: 'Select a reason these cattle were not tested', href: '#reason' })
    }
    if (errorList.length) {
      return renderUntestedReasons(req, res, {
        errors,
        errorSummary: { titleText: 'There is a problem', errorList: errorList },
        formValues: { reason, reasonOther }
      })
    }

    selectedIds.forEach(function (id) {
      reasons[id] = reason
      if (reason === 'other') { others[id] = reasonOther } else { delete others[id] }
    })
    req.session.data.skinTestUntestedReasons = reasons
    req.session.data.skinTestUntestedReasonOthers = others

    // Any untested cattle still without a reason? Loop. Otherwise continue.
    const stillRemaining = untestedAnimals.some(function (a) { return !reasons[a.officialId] })
    if (stillRemaining) {
      return res.redirect(`/${version}/skin-test-untested-reason`)
    }
    return res.redirect(untestedReasonsDoneHref(req))
  })

  // --- v1-3: part-test explainer ---------------------------------------
  // Shown when one or more animals were marked "to be tested on a return
  // visit". The herd test isn't complete, so this confirms the report
  // will be filed as a part test and the test stays open.
  function getReturnVisitAnimals(req) {
    const reasons = req.session.data.skinTestUntestedReasons || {}
    return getUntestedAnimals(req).filter(function (a) { return isStillToTestReason(reasons[a.officialId]) })
  }

  router.get(`/${version}/skin-test-part-test`, function (req, res) {
    if (!isV13Plus(version)) {
      return res.redirect(`/${version}/skin-test-add-cattle-question`)
    }
    const returnVisit = getReturnVisitAnimals(req)
    if (returnVisit.length === 0) {
      return res.redirect(`/${version}/skin-test-add-cattle-question`)
    }
    res.render(`${version}/skin-test-part-test`, {
      stillToTestCount: returnVisit.length,
      returnVisitAnimals: returnVisit
    })
  })

  router.post(`/${version}/skin-test-part-test`, function (req, res) {
    res.redirect(`/${version}/skin-test-add-cattle-question`)
  })

  router.get(`/${version}/skin-test-untested-reason/:index`, function (req, res) {
    // v1-3 uses the bulk page above, not the per-animal wizard.
    if (isV13Plus(version)) {
      return res.redirect(`/${version}/skin-test-untested-reason`)
    }
    const untestedAnimals = getUntestedAnimals(req)
    if (untestedAnimals.length === 0) {
      return res.redirect(`/${version}/skin-test-untested`)
    }
    const index = Math.max(0, Math.min(parseInt(req.params.index, 10) || 0, untestedAnimals.length - 1))
    req.session.data.currentUntestedIndex = index
    renderUntestedReason(req, res, index)
  })

  router.post(`/${version}/skin-test-untested-reason/:index`, function (req, res) {
    // v1-3 uses the bulk page above, not the per-animal wizard.
    if (isV13Plus(version)) {
      return res.redirect(`/${version}/skin-test-untested-reason`)
    }
    const untestedAnimals = getUntestedAnimals(req)
    if (untestedAnimals.length === 0) {
      return res.redirect(`/${version}/skin-test-untested`)
    }

    const index = Math.max(0, Math.min(parseInt(req.params.index, 10) || 0, untestedAnimals.length - 1))
    const currentAnimal = untestedAnimals[index]
    const reason = (req.body.reason || '').trim()
    const reasonOther = (req.body.reasonOther || '').trim()

    // Validation: a reason is required. The "other" text isn't required
    // in the prototype – the vet can leave it blank.
    if (!reason) {
      return renderUntestedReason(req, res, index, {
        errors: { reason: { text: 'Select a reason this animal was not tested' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select a reason this animal was not tested', href: '#reason' }]
        },
        formValues: { reason, reasonOther }
      })
    }

    // Persist the reason against the officialId so the confirmation
    // page and final report can surface it.
    const reasons = Object.assign({}, req.session.data.skinTestUntestedReasons || {})
    const others = Object.assign({}, req.session.data.skinTestUntestedReasonOthers || {})
    reasons[currentAnimal.officialId] = reason
    if (reason === 'other') {
      others[currentAnimal.officialId] = reasonOther
    } else {
      delete others[currentAnimal.officialId]
    }
    req.session.data.skinTestUntestedReasons = reasons
    req.session.data.skinTestUntestedReasonOthers = others

    // Advance to the next untested animal, or to the review page if
    // this was the last one.
    if (index < untestedAnimals.length - 1) {
      const nextIndex = index + 1
      req.session.data.currentUntestedIndex = nextIndex
      return res.redirect(`/${version}/skin-test-untested-reason/${nextIndex}`)
    }

    req.session.data.currentUntestedIndex = untestedAnimals.length - 1
    res.redirect(`/${version}/skin-test-confirmation`)
  })

  // "Which test first?" – only reached when the vet has chosen "Both"
  // on the skin-test-type page. The selection tells us which measurement
  // loop to start with; the other loop is triggered automatically once
  // the first is complete.
  router.get(`/${version}/skin-test-both-order`, function (req, res) {
    if (req.session.data.skinTestType !== 'Both') {
      return res.redirect(`/${version}/skin-test-type`)
    }
    res.render(`${version}/skin-test-both-order`)
  })

  router.post(`/${version}/skin-test-both-order`, function (req, res) {
    const skinTestFirstOrder = req.body.skinTestFirstOrder
    req.session.data.skinTestFirstOrder = skinTestFirstOrder

    if (!skinTestFirstOrder) {
      return res.render(`${version}/skin-test-both-order`, {
        errors: { skinTestFirstOrder: { text: 'Select which test you want to record first' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select which test you want to record first', href: '#skinTestFirstOrder' }]
        }
      })
    }

    req.session.data.currentSkinTestIndex = 0
    req.session.data.currentDivaIndex = 0
    req.session.data.completedSkinTestPhases = []

    // The order is recorded; now move on to the "did any cattle
    // react?" gate. The first measurement loop will follow once the
    // vet has picked their reactors.
    res.redirect(`/${version}/skin-test-reactors-any`)
  })

  function renderMeasurement(req, res, index, options) {
    // SICCT measurements apply to unvaccinated cattle only – the DIVA
    // phase handles vaccinated cattle on its own page.
    const entries = getEntriesForPhase(req, 'sicct')
    const total = entries.length
    const safeIndex = Math.max(0, Math.min(index, total - 1))
    const currentAnimal = entries[safeIndex]
    const completedCount = entries.filter(e => e.status === 'done' || e.status === 'not-done').length
    const progressPercent = total > 0 ? Math.round((completedCount / total) * 100) : 0

    const isBoth = req.session.data.skinTestType === 'Both'
    const firstOrder = req.session.data.skinTestFirstOrder || 'sicct'
    // For "Both", show the vet which phase of the pair they're on so the
    // "Step X of 2" indicator reflects their chosen order.
    const bothStep = isBoth
      ? (firstOrder === 'sicct' ? 'Step 1 of 2' : 'Step 2 of 2')
      : null

    // The natural "back" destination depends on whether the vet is in
    // the middle of the loop, at the start of the loop, or at the start
    // of a "Both" journey where DIVA was done first.
    const atStart = safeIndex === 0
    const divaAlreadyDone = (req.session.data.completedSkinTestPhases || []).includes('diva')
    const backHref = !atStart
      ? `/${version}/skin-test-measurements/${safeIndex - 1}`
      : (isBoth && divaAlreadyDone
          ? `/${version}/skin-test-diva/${Math.max((getEntriesForPhase(req, 'diva').length - 1), 0)}`
          : (isBoth ? `/${version}/skin-test-both-order` : `/${version}/skin-test-reactors`))

    res.render(`${version}/skin-test-measurements`, {
      currentIndex: safeIndex,
      currentPosition: safeIndex + 1,
      totalCattle: total,
      completedCount,
      remainingCount: total - completedCount,
      progressPercent,
      currentAnimal,
      savedEntry: currentAnimal,
      // Caption label – always "SICCT" on this page. The "Both" journey
      // is communicated via the step indicator and the inset banner.
      displayTestType: 'SICCT',
      isBothJourney: isBoth,
      bothStepText: bothStep,
      journeyTestType: req.session.data.skinTestType || 'SICCT',
      backHref,
      errors: options && options.errors,
      errorSummary: options && options.errorSummary,
      formValues: (options && options.formValues) || {}
    })
  }

  router.get(`/${version}/skin-test-measurements`, function (req, res) {
    // v1-2: SICCT measurements are now recorded on the same
    // tabular page as DIVA (/v1-2/skin-test-diva-table), so vets
    // can enter every reactor's readings on one screen rather
    // than stepping through one animal at a time. Older versions
    // keep the per-animal measurement loop.
    if ((version === 'v1-2' || isV13Plus(version))) {
      return res.redirect(`/${version}/${testTablePath}`)
    }
    const entries = getEntriesForPhase(req, 'sicct')
    if (!entries.length) {
      // No SICCT reactors – send the vet to the "were all of the
      // cattle tested?" gate (or back to the reactor step if reactors
      // haven't been chosen yet).
      if (!Array.isArray(req.session.data.skinTestReactors)) {
        return res.redirect(`/${version}/skin-test-reactors`)
      }
      return res.redirect(`/${version}/skin-test-all-tested`)
    }
    const resumeIndex = Number.isInteger(req.session.data.currentSkinTestIndex)
      ? Math.min(req.session.data.currentSkinTestIndex, entries.length - 1)
      : 0
    res.redirect(`/${version}/skin-test-measurements/${resumeIndex}`)
  })

  router.get(`/${version}/skin-test-measurements/:index`, function (req, res) {
    // v1-2: redirect the per-animal URL to the tabular measurement
    // page; v1-0 / v1-1 still use the per-animal loop.
    if ((version === 'v1-2' || isV13Plus(version))) {
      return res.redirect(`/${version}/${testTablePath}`)
    }
    const entries = getEntriesForPhase(req, 'sicct')
    if (!entries.length) {
      // No SICCT reactors – send the vet to the "were all of the
      // cattle tested?" gate (or back to the reactor step if reactors
      // haven't been chosen yet).
      if (!Array.isArray(req.session.data.skinTestReactors)) {
        return res.redirect(`/${version}/skin-test-reactors`)
      }
      return res.redirect(`/${version}/skin-test-all-tested`)
    }
    const index = Math.max(0, Math.min(parseInt(req.params.index, 10) || 0, entries.length - 1))
    req.session.data.currentSkinTestIndex = index
    req.session.data.currentSkinTestPhase = 'sicct'
    renderMeasurement(req, res, index)
  })

  router.post(`/${version}/skin-test-measurements/:index`, function (req, res) {
    const entries = getEntriesForPhase(req, 'sicct')
    if (!entries.length) {
      // No SICCT reactors – send the vet to the "were all of the
      // cattle tested?" gate (or back to the reactor step if reactors
      // haven't been chosen yet).
      if (!Array.isArray(req.session.data.skinTestReactors)) {
        return res.redirect(`/${version}/skin-test-reactors`)
      }
      return res.redirect(`/${version}/skin-test-all-tested`)
    }

    const index = Math.max(0, Math.min(parseInt(req.params.index, 10) || 0, entries.length - 1))
    const loopAction = req.body.loopAction || 'next'

    // The "what happened with this animal?" radio is gone – the page
    // now always captures measurements (the vet only reaches it for
    // animals they ticked as reactors). Anything left blank is just
    // blank in the saved entry.
    // Map the filtered (SICCT-only) index back to the full skinTestEntries
    // array so we store the data against the right animal.
    const targetOriginalIndex = entries[index] && entries[index].originalIndex
    const allAnimalsCount = getEntries(req).length

    const entry = {
      status: 'done',
      performedTest: 'SICCT',
      // --- SICCT (Avian + Bovine, Pre + Post) -----------------------
      avianBeforeInjection: (req.body.avianBeforeInjection || '').trim(),
      avianAfter72Hours: (req.body.avianAfter72Hours || '').trim(),
      bovineBeforeInjection: (req.body.bovineBeforeInjection || '').trim(),
      bovineAfter72Hours: (req.body.bovineAfter72Hours || '').trim(),
      reactionDescription: (req.body.reactionDescription || '').trim(),
      overallResult: (req.body.overallResult || '').trim(),
      additionalNotes: (req.body.additionalNotes || '').trim()
    }

    // Persist the updated entry against the underlying animal
    const stored = Array.isArray(req.session.data.skinTestEntries)
      ? [...req.session.data.skinTestEntries]
      : []
    while (stored.length < allAnimalsCount) {
      stored.push(blankEntry())
    }
    stored[targetOriginalIndex] = Object.assign({}, stored[targetOriginalIndex] || blankEntry(), entry)
    req.session.data.skinTestEntries = stored

    if (loopAction === 'save-exit') {
      req.session.data.currentSkinTestIndex = index
      req.session.data.currentSkinTestPhase = 'sicct'
      req.session.data.savedBanner = 'skin-test-report'
      req.session.data.skinTestInProgress = true
      return res.redirect(`/${version}/dashboard`)
    }

    if (loopAction === 'previous') {
      const previousIndex = Math.max(0, index - 1)
      req.session.data.currentSkinTestIndex = previousIndex
      return res.redirect(`/${version}/skin-test-measurements/${previousIndex}`)
    }

    // Default: move to the next cattle or to review
    if (index < entries.length - 1) {
      const nextIndex = index + 1
      req.session.data.currentSkinTestIndex = nextIndex
      return res.redirect(`/${version}/skin-test-measurements/${nextIndex}`)
    }

    // Reached the last SICCT cattle. Mark the SICCT phase complete.
    req.session.data.currentSkinTestIndex = entries.length - 1
    const completed = Array.isArray(req.session.data.completedSkinTestPhases)
      ? req.session.data.completedSkinTestPhases.slice()
      : []
    if (!completed.includes('sicct')) completed.push('sicct')
    req.session.data.completedSkinTestPhases = completed

    // For the "Both" journey, hand off to the DIVA reactor flow if
    // it's still outstanding. The vet picks DIVA reactors (which may
    // be a different set from the SICCT reactors), then enters DIVA
    // measurements for those animals.
    const isBoth = req.session.data.skinTestType === 'Both'
    if (isBoth && !completed.includes('diva')) {
      return res.redirect(`/${version}/skin-test-reactors-any`)
    }

    // All reactor measurements are captured – move on to the
    // "were all of the cattle tested?" question, which gates the
    // mark-untested step.
    res.redirect(`/${version}/skin-test-all-tested`)
  })

  // ---------------------------------------------------------------------------
  // DIVA loop – only reached when skinTestType is 'DIVA' or the DIVA phase
  // of 'Both'. The page is deliberately separate from the SICCT skin
  // measurement page so that layout can stay untouched.
  // ---------------------------------------------------------------------------

  function renderDivaMeasurement(req, res, index, options) {
    // DIVA applies to vaccinated cattle only.
    const entries = getEntriesForPhase(req, 'diva')
    const total = entries.length
    const safeIndex = Math.max(0, Math.min(index, total - 1))
    const currentAnimal = entries[safeIndex]
    const completedCount = entries.filter(e => e.divaStatus === 'done' || e.divaStatus === 'not-done').length
    const progressPercent = total > 0 ? Math.round((completedCount / total) * 100) : 0

    const isBoth = req.session.data.skinTestType === 'Both'
    const firstOrder = req.session.data.skinTestFirstOrder || 'sicct'
    const bothStep = isBoth
      ? (firstOrder === 'diva' ? 'Step 1 of 2' : 'Step 2 of 2')
      : null

    const atStart = safeIndex === 0
    const sicctAlreadyDone = (req.session.data.completedSkinTestPhases || []).includes('sicct')
    const backHref = !atStart
      ? `/${version}/skin-test-diva/${safeIndex - 1}`
      : (isBoth && sicctAlreadyDone
          ? `/${version}/skin-test-measurements/${Math.max((getEntriesForPhase(req, 'sicct').length - 1), 0)}`
          : (isBoth ? `/${version}/skin-test-both-order` : `/${version}/skin-test-reactors`))

    // DIVA batch numbers entered on /skin-test-type. When the vet
    // recorded more than one, the measurement page asks them to
    // confirm which batch was used for this specific animal.
    const divaBatches = (Array.isArray(req.session.data.skinTestDivaBatches)
      ? req.session.data.skinTestDivaBatches
      : []).map(function (b) { return (b || '').trim() }).filter(Boolean)
    const sicctBatches = (Array.isArray(req.session.data.skinTestSicctBatches)
      ? req.session.data.skinTestSicctBatches
      : []).map(function (b) { return (b || '').trim() }).filter(Boolean)

    // For v1-2 Both, this page handles SICCT and DIVA measurements in
    // one loop – the vet picks the test per animal up top. The
    // recommended test pre-selects DIVA for vaccinated cattle and
    // SICCT for everyone else.
    const isCombinedBoth = isBoth && (version === 'v1-2' || isV13Plus(version))
    const recommendedTest = currentAnimal && currentAnimal.vaccinationStatus === 'Vaccinated'
      ? 'DIVA'
      : 'SICCT'

    res.render(`${version}/skin-test-diva`, {
      currentIndex: safeIndex,
      currentPosition: safeIndex + 1,
      totalCattle: total,
      completedCount,
      remainingCount: total - completedCount,
      progressPercent,
      currentAnimal,
      savedEntry: currentAnimal,
      displayTestType: 'DIVA',
      isBothJourney: isBoth,
      isCombinedBoth,
      recommendedTest,
      bothStepText: bothStep,
      backHref,
      divaBatches,
      sicctBatches,
      errors: options && options.errors,
      errorSummary: options && options.errorSummary,
      formValues: (options && options.formValues) || {}
    })
  }

  router.get(`/${version}/skin-test-diva`, function (req, res) {
    const entries = getEntriesForPhase(req, 'diva')
    if (!entries.length) {
      // No DIVA reactors – same fallback path as the SICCT guard.
      if (!Array.isArray(req.session.data.skinTestReactors)) {
        return res.redirect(`/${version}/skin-test-reactors`)
      }
      return res.redirect(`/${version}/skin-test-all-tested`)
    }
    // v1-2: vets asked to record every reactor on a single screen
    // instead of stepping through one animal per page. The tabular
    // view at /skin-test-diva-table is now the default; the per-
    // animal loop is still available via the "record one at a time"
    // link on that page (or directly at /skin-test-diva/:index).
    if ((version === 'v1-2' || isV13Plus(version))) {
      return res.redirect(`/${version}/${testTablePath}`)
    }
    const resumeIndex = Number.isInteger(req.session.data.currentDivaIndex)
      ? Math.min(req.session.data.currentDivaIndex, entries.length - 1)
      : 0
    res.redirect(`/${version}/skin-test-diva/${resumeIndex}`)
  })

  // -------------------------------------------------------------------------
  // v1-2 only: bulk skin-test measurement table. Lists every reactor on a
  // single screen, with a per-row dropdown picking the test that was done
  // on that animal (SICCT or DIVA, pre-selected from vaccination status).
  // Avian fields are disabled when the row's test is DIVA (DIVA is bovine
  // only). On submit the route saves each row according to its test
  // type, auto-derives the result, marks both phases complete and
  // continues to /skin-test-all-tested.
  // -------------------------------------------------------------------------

  // Return every reactor (across both SICCT and DIVA phases) with its
  // original entries index attached, so the bulk-save route can write
  // each row back into the right slot in skinTestEntries.
  function getAllReactorEntriesForTable(req) {
    const all = getEntries(req)
    const reactorIds = new Set([
      ...getReactorsForPhase(req, 'sicct'),
      ...getReactorsForPhase(req, 'diva')
    ])
    return all
      .map(function (entry, originalIndex) {
        return Object.assign({}, entry, { originalIndex })
      })
      .filter(function (entry) {
        return reactorIds.has(entry.officialId)
      })
  }

  // Render the bulk measurement table. Extracted so the POST handler can
  // re-render it with validation errors (e.g. a normal reactor missing
  // its readings) while preserving everything the vet has entered.
  function renderDivaTable(req, res, extra) {
    extra = extra || {}
    if ((version !== 'v1-2' && !isV13Plus(version))) {
      return res.redirect(`/${version}/skin-test-diva`)
    }
    const perTest = isPerTestSubFlow(req)
    let entries = getAllReactorEntriesForTable(req)
    if (perTest) {
      // Scope the measurement table to only this test's reactors.
      const activeTest = req.session.data.currentSkinTest
      const phaseReactorIds = new Set(getReactorsForPhase(req, activeTest))
      entries = entries.filter(function (e) { return phaseReactorIds.has(e.officialId) })
    }
    if (!entries.length) {
      // Per-test sub-flow: if there are no reactors for this test the
      // vet has already answered "no" on reactors-any (or hit Skip)
      // so jump straight to the per-test confirm summary.
      if (perTest) {
        return res.redirect(`/${version}/skin-test-confirm-test/${req.session.data.currentSkinTest}`)
      }
      if (!Array.isArray(req.session.data.skinTestReactors)) {
        return res.redirect(`/${version}/skin-test-reactors`)
      }
      return res.redirect(`/${version}/skin-test-all-tested`)
    }
    const skinTestType = req.session.data.skinTestType || 'SICCT'
    const isBoth = skinTestType === 'Both'
    // In the per-test sub-flow the test is fixed for the page, so the
    // per-row dropdown is locked. The combined-Both view keeps it
    // switchable for backwards compatibility.
    const canSwitchTest = isBoth && !perTest

    // Server-side pagination: show the reactor rows 10 at a time and
    // "Save and continue" between pages (the GOV.UK approach for a long
    // data-entry list). Each page saves its own rows, so nothing relies
    // on JavaScript or a hidden full-length form.
    const DIVA_PAGE_SIZE = 10
    const totalPages = Math.max(1, Math.ceil(entries.length / DIVA_PAGE_SIZE))
    let currentPage = parseInt(extra.page, 10)
    if (isNaN(currentPage) || currentPage < 1) currentPage = 1
    if (currentPage > totalPages) currentPage = totalPages
    const pageStart = (currentPage - 1) * DIVA_PAGE_SIZE
    const isLastPage = currentPage >= totalPages
    // Back steps to the previous page, or out to the reactors list on
    // page 1.
    const backHref = currentPage > 1
      ? `/${version}/${testTablePath}?page=${currentPage - 1}`
      : `/${version}/skin-test-reactors`

    const divaBatches = (Array.isArray(req.session.data.skinTestDivaBatches)
      ? req.session.data.skinTestDivaBatches
      : []).map(function (b) { return (b || '').trim() }).filter(Boolean)
    const sicctBatches = (Array.isArray(req.session.data.skinTestSicctBatches)
      ? req.session.data.skinTestSicctBatches
      : []).map(function (b) { return (b || '').trim() }).filter(Boolean)

    // Compute a per-row default test ("recommended") so the dropdown
    // sits on the right value before the vet touches anything. Pull
    // the vaccination date back out of the animal dataset so the
    // "TB Vax" column can show it directly (getEntries drops it).
    const skinAnimalsById = {}
    getSkinTestAnimals(req).forEach(function (a) {
      skinAnimalsById[a.officialId] = a
    })

    // Rows that failed validation (a reactor missing its readings) get a
    // red marker so the vet can see which still need filling in.
    const rowErrors = extra.rowErrors || {}

    // Source-page lookup: for each reactor entry, work out which page
    // of the printed list it came from so the table can group rows
    // under "From page N" dividers (matching the page-break cadence
    // on the vet's printed list).
    const preparedPageSize = req.session.data.skinTestCattlePerPage || 18
    const allSkinTestAnimals = getSkinTestAnimals(req)
    const perTestAnimalIds = perTest
      ? getPerTestAnimalIdSet(req, req.session.data.currentSkinTest)
      : null
    const orderedForSourcing = perTest && perTestAnimalIds && perTestAnimalIds.size > 0
      ? allSkinTestAnimals.filter(function (a) { return perTestAnimalIds.has(a.officialId) })
      : allSkinTestAnimals
    const sourceIndexById = {}
    orderedForSourcing.forEach(function (a, idx) {
      sourceIndexById[a.officialId] = idx
    })
    function sourcePageFor (officialId) {
      const idx = sourceIndexById[officialId]
      if (typeof idx !== 'number') return null
      return Math.floor(idx / preparedPageSize) + 1
    }

    const enriched = entries.map(function (e) {
      const recommended = e.isVaccinated ? 'DIVA' : 'SICCT'
      // Per-test sub-flow: every row in this table belongs to the
      // active test, so rowTest is fixed regardless of recommendation.
      const perTestRowTest = perTest
        ? (req.session.data.currentSkinTest === 'diva' ? 'DIVA' : 'SICCT')
        : null
      const rowTest = perTestRowTest
        || e.performedTest
        || (isBoth ? recommended : (skinTestType === 'DIVA' ? 'DIVA' : 'SICCT'))
      // For DIVA rows, bovine measurements live in the DIVA fields;
      // for SICCT rows they live in the SICCT fields. The template
      // displays whichever pair applies to the current rowTest.
      const bovinePre = rowTest === 'DIVA'
        ? (e.divaBovineBeforeInjection || '')
        : (e.bovineBeforeInjection || '')
      const bovinePost = rowTest === 'DIVA'
        ? (e.divaBovineAfter72Hours || '')
        : (e.bovineAfter72Hours || '')
      const animal = skinAnimalsById[e.officialId] || {}
      return Object.assign({}, e, {
        rowTest,
        recommendedTest: recommended,
        displayBovinePre: bovinePre,
        displayBovinePost: bovinePost,
        vaccinationDate: animal.vaccinationDate || '',
        // C / SO dropdowns in the Reaction Desc column. Left blank
        // when nothing's been picked yet so the "Select" placeholder
        // is the default option shown.
        avianOedema: e.avianOedema || '',
        bovineOedema: e.bovineOedema || '',
        rowError: !!rowErrors[e.originalIndex],
        // Source-page back-reference – the page number on the
        // printed list where this animal was originally listed.
        // Drives the "From page N" dividers in the template.
        sourcePage: sourcePageFor(e.officialId)
      })
    })

    const pageEntries = enriched.slice(pageStart, pageStart + DIVA_PAGE_SIZE)

    res.render(`${version}/${testTablePath}`, {
      entries: pageEntries,
      backHref,
      divaBatches,
      sicctBatches,
      skinTestType,
      canSwitchTest,
      currentPage,
      totalPages,
      isLastPage,
      pageStart,
      totalReactors: entries.length,
      errorSummary: extra.errorSummary,
      showOverride: extra.showOverride
    })
  }

  router.get(`/${version}/${testTablePath}`, function (req, res) {
    return renderDivaTable(req, res, { page: req.query.page })
  })

  // v1-3 legacy redirect: keep the old /skin-test-diva-table URL working
  // (bookmarks, changelog links) by forwarding it to the new path.
  if (isV13Plus(version)) {
    router.get(`/${version}/skin-test-diva-table`, function (req, res) {
      const q = req.query.page ? `?page=${req.query.page}` : ''
      return res.redirect(`/${version}/skin-test-table${q}`)
    })
    router.post(`/${version}/skin-test-diva-table`, function (req, res) {
      return res.redirect(307, `/${version}/skin-test-table`)
    })
  }

  router.post(`/${version}/${testTablePath}`, function (req, res) {
    if ((version !== 'v1-2' && !isV13Plus(version))) {
      return res.redirect(`/${version}/skin-test-diva`)
    }
    const perTest = isPerTestSubFlow(req)
    const activeTest = perTest ? req.session.data.currentSkinTest : null
    let entries = getAllReactorEntriesForTable(req)
    if (perTest) {
      const phaseReactorIds = new Set(getReactorsForPhase(req, activeTest))
      entries = entries.filter(function (e) { return phaseReactorIds.has(e.officialId) })
    }
    if (!entries.length) {
      if (perTest) {
        return res.redirect(`/${version}/skin-test-confirm-test/${activeTest}`)
      }
      return res.redirect(`/${version}/skin-test-all-tested`)
    }

    // Server-side pagination: this submit only carries the rows for the
    // page the vet was on, so we save and validate just those rows and
    // then step to the next page (or finish on the last one).
    const DIVA_PAGE_SIZE = 10
    const totalPages = Math.max(1, Math.ceil(entries.length / DIVA_PAGE_SIZE))
    let currentPage = parseInt(req.body.page, 10)
    if (isNaN(currentPage) || currentPage < 1) currentPage = 1
    if (currentPage > totalPages) currentPage = totalPages
    const pageStart = (currentPage - 1) * DIVA_PAGE_SIZE
    const pageEntries = entries.slice(pageStart, pageStart + DIVA_PAGE_SIZE)
    const isLastPage = currentPage >= totalPages

    const allAnimalsCount = getEntries(req).length
    const stored = Array.isArray(req.session.data.skinTestEntries)
      ? [...req.session.data.skinTestEntries]
      : []
    while (stored.length < allAnimalsCount) {
      stored.push(blankEntry())
    }

    // Single-batch cases are applied silently; with multiple batches the
    // vet picks one for the whole table via the radios below it.
    const divaBatchesList = (Array.isArray(req.session.data.skinTestDivaBatches)
      ? req.session.data.skinTestDivaBatches
      : []).map(function (b) { return (b || '').trim() }).filter(Boolean)
    const sicctBatchesList = (Array.isArray(req.session.data.skinTestSicctBatches)
      ? req.session.data.skinTestSicctBatches
      : []).map(function (b) { return (b || '').trim() }).filter(Boolean)
    const divaBatchUsedForAll = divaBatchesList.length === 1
      ? divaBatchesList[0]
      : (req.body.divaBatchUsedAll || '').trim()
    const sicctBatchUsedForAll = sicctBatchesList.length === 1
      ? sicctBatchesList[0]
      : (req.body.sicctBatchUsedAll || '').trim()

    // Remember the chosen batch so it stays selected on the next page
    // rather than resetting the radios each time.
    if (divaBatchUsedForAll) req.session.data.divaBatchUsedAll = divaBatchUsedForAll
    if (sicctBatchUsedForAll) req.session.data.sicctBatchUsedAll = sicctBatchUsedForAll

    const skinTestType = req.session.data.skinTestType || 'SICCT'
    const isBoth = skinTestType === 'Both'

    // Only the rows on the submitted page are present in req.body, so
    // save just those – iterating all entries would blank the others.
    pageEntries.forEach(function (entry) {
      const i = entry.originalIndex
      let test = (req.body['test-' + i] || '').trim()
      if (test !== 'SICCT' && test !== 'DIVA') {
        // Fall back to the active per-test test, the journey type, or
        // the per-row recommendation.
        if (perTest) {
          test = activeTest === 'diva' ? 'DIVA' : 'SICCT'
        } else {
          test = isBoth
            ? (entry.isVaccinated ? 'DIVA' : 'SICCT')
            : (skinTestType === 'DIVA' ? 'DIVA' : 'SICCT')
        }
      }
      const avianPre = (req.body['avianPre-' + i] || '').trim()
      const avianPost = (req.body['avianPost-' + i] || '').trim()
      const bovinePre = (req.body['bovinePre-' + i] || '').trim()
      const bovinePost = (req.body['bovinePost-' + i] || '').trim()

      if (test === 'DIVA') {
        // DIVA result derived from the reading:
        //   ≤ 2 mm → negative
        //   > 2 mm → positive (reactor)
        // No inconclusive band – DIVA on this prototype is a single
        // pass/fail call against the 2 mm threshold.
        let divaResult = ''
        const pre = parseFloat(bovinePre)
        const post = parseFloat(bovinePost)
        if (!isNaN(pre) && !isNaN(post)) {
          const diff = post - pre
          if (diff > 2) divaResult = 'positive'
          else divaResult = 'negative'
        }
        const hasAnyValue = bovinePre !== '' || bovinePost !== ''
        const wasDone = stored[i] && stored[i].divaStatus === 'done'
        stored[i] = Object.assign({}, stored[i] || blankEntry(), {
          performedTest: 'DIVA',
          divaStatus: (hasAnyValue || wasDone) ? 'done' : (stored[i] && stored[i].divaStatus) || null,
          divaBovineBeforeInjection: bovinePre,
          divaBovineAfter72Hours: bovinePost,
          divaResult,
          divaBatchUsed: divaBatchUsedForAll || (stored[i] && stored[i].divaBatchUsed) || '',
          // Clear SICCT fields so a previous SICCT save doesn't bleed
          // through if the vet switched this row to DIVA.
          avianBeforeInjection: '',
          avianAfter72Hours: '',
          bovineBeforeInjection: '',
          bovineAfter72Hours: '',
          overallResult: '',
          sicctBatchUsed: ''
        })
      } else {
        // SICCT – delegate the interpretation to the rules engine so
        // the route never encodes TB threshold logic itself. The
        // helper accepts the full TB64-style input set (increases,
        // oedema, palpable reaction, interpretation type) and
        // returns a structured result. The C / SO dropdowns in the
        // Reaction Desc column feed the oedema inputs; palpable
        // reaction stays at the default ('-') for now. Interpretation
        // type defaults to "standard"; a per-row override could be
        // plumbed in later.
        const aPre = parseFloat(avianPre)
        const aPost = parseFloat(avianPost)
        const bPre = parseFloat(bovinePre)
        const bPost = parseFloat(bovinePost)
        const measurementsComplete = !isNaN(aPre) && !isNaN(aPost) && !isNaN(bPre) && !isNaN(bPost)
        const avianOedemaRaw = (req.body['avianOedema-' + i] || 'C').trim().toUpperCase()
        const bovineOedemaRaw = (req.body['bovineOedema-' + i] || 'C').trim().toUpperCase()
        const avianOedema = avianOedemaRaw === 'SO' ? 'SO' : 'C'
        const bovineOedema = bovineOedemaRaw === 'SO' ? 'SO' : 'C'
        const interpretation = measurementsComplete
          ? sicctInterpretation.interpretSicct({
              avianIncrease: aPost - aPre,
              bovineIncrease: bPost - bPre,
              avianOedema: avianOedema,
              bovineOedema: bovineOedema,
              interpretationType: (req.body['sicctInterpretation-' + i] || 'standard').trim()
            })
          : null

        // Map the rules-engine output back to the legacy
        // overallResult string the rest of the prototype reads.
        const overallResult = interpretation
          ? sicctInterpretation.toLegacyOverallResult(interpretation.resultCode)
          : ''

        const hasAnyValue = avianPre !== '' || avianPost !== '' || bovinePre !== '' || bovinePost !== ''
        const wasDone = stored[i] && stored[i].divaStatus === 'done'
        stored[i] = Object.assign({}, stored[i] || blankEntry(), {
          performedTest: 'SICCT',
          divaStatus: (hasAnyValue || wasDone) ? 'done' : (stored[i] && stored[i].divaStatus) || null,
          avianBeforeInjection: avianPre,
          avianAfter72Hours: avianPost,
          bovineBeforeInjection: bovinePre,
          bovineAfter72Hours: bovinePost,
          avianOedema: avianOedema,
          bovineOedema: bovineOedema,
          overallResult,
          // Persist the full structured interpretation alongside the
          // legacy result so the confirmation / submitted pages can
          // surface the explanation and next action when they're
          // updated to read the new shape.
          sicctInterpretation: interpretation,
          sicctBatchUsed: sicctBatchUsedForAll || (stored[i] && stored[i].sicctBatchUsed) || '',
          // Clear DIVA fields so a previous DIVA save doesn't bleed
          // through if the vet switched this row to SICCT.
          divaBovineBeforeInjection: '',
          divaBovineAfter72Hours: '',
          divaResult: '',
          divaBatchUsed: ''
        })
      }
    })
    req.session.data.skinTestEntries = stored
    req.session.data.currentDivaIndex = entries.length - 1

    // v1-3: a reactor must have its readings entered before the report
    // can proceed. Validate after saving so the vet keeps everything they
    // typed, and re-render the table with errors if any reactor is
    // incomplete. "Save and continue later" bypasses this.
    if (isV13Plus(version) && (req.body.saveAction || '').trim() !== 'save-exit') {
      // The vet can override the "all readings required" check – a
      // reading may be illegible or impossible to take, so they're
      // allowed to leave boxes empty and still submit. The first
      // incomplete submit shows which animals are affected and reveals
      // an acknowledgement checkbox; ticking it and submitting again
      // lets the report through with the gaps.
      // The checkbox posts an array when the kit's hidden "_unchecked"
      // companion field is present (e.g. ['_unchecked', 'yes']), so
      // normalise to a simple "did they tick yes?" check.
      const overrideRaw = req.body.overrideMissingReadings
      const override = Array.isArray(overrideRaw)
        ? overrideRaw.indexOf('yes') !== -1
        : (overrideRaw || '').trim() === 'yes'
      const rowErrors = {}
      const errorList = []
      pageEntries.forEach(function (entry) {
        const i = entry.originalIndex
        let test = (req.body['test-' + i] || '').trim()
        if (test !== 'SICCT' && test !== 'DIVA') {
          test = (req.session.data.skinTestType === 'DIVA') ? 'DIVA' : 'SICCT'
        }
        const v = function (n) { return (req.body[n + '-' + i] || '').trim() }
        const missing = test === 'DIVA'
          ? (v('bovinePre') === '' || v('bovinePost') === '')
          : (v('avianPre') === '' || v('avianPost') === '' || v('bovinePre') === '' || v('bovinePost') === '')
        if (missing) {
          rowErrors[i] = true
          errorList.push({ text: 'Enter all measurements for ' + entry.officialId, href: '#bovinePre-' + i })
        }
      })
      if (errorList.length && !override) {
        // Add an anchor link to the error summary so the vet can jump
        // straight to the "submit with blank entries" option without
        // scrolling past every animal.
        const errorListWithOverride = errorList.concat([
          { text: 'Or submit the report with blank entries', href: '#overrideMissingReadings' }
        ])
        return renderDivaTable(req, res, {
          errorSummary: { titleText: 'There is a problem', errorList: errorListWithOverride },
          rowErrors: rowErrors,
          // Reveal the acknowledgement checkbox so the vet can choose to
          // submit with readings missing.
          showOverride: true,
          // Stay on the page the vet was completing.
          page: currentPage
        })
      }
    }

    // "Save and continue later" – persist whatever the vet has filled
    // in, mark the report as in-progress so the dashboard can offer a
    // Resume link, and bail out before we mark the phases complete or
    // redistribute reactor IDs. The vet picks up where they left off
    // by clicking back into the in-progress card on the dashboard.
    const saveAction = (req.body.saveAction || '').trim()
    if (saveAction === 'save-exit') {
      // Remember which test the vet was on so the resume flow can
      // pick up the right per-test sub-flow.
      req.session.data.currentSkinTestPhase = perTest ? activeTest : 'diva'
      req.session.data.savedBanner = 'skin-test-report'
      req.session.data.skinTestInProgress = true
      return res.redirect(`/${version}/dashboard`)
    }

    // Not the last page yet – this page is saved and valid, so move on
    // to the next 10 reactors rather than finishing the report.
    if (!isLastPage) {
      return res.redirect(`/${version}/${testTablePath}?page=${currentPage + 1}`)
    }

    // Per-test sub-flow: only mark the active test complete. Reactor
    // IDs were already assigned to this phase by the reactors POST, so
    // there's no redistribution to do. Hand off to the per-test
    // confirm page – it decides where to go next.
    if (perTest) {
      const completedPhases = Array.isArray(req.session.data.completedSkinTestPhases)
        ? req.session.data.completedSkinTestPhases.slice()
        : []
      if (!completedPhases.includes(activeTest)) completedPhases.push(activeTest)
      req.session.data.completedSkinTestPhases = completedPhases
      return res.redirect(`/${version}/skin-test-confirm-test/${activeTest}`)
    }

    // Legacy combined-Both v1-2 path: mark both phases complete – this
    // single page covers everything.
    const completed = Array.isArray(req.session.data.completedSkinTestPhases)
      ? req.session.data.completedSkinTestPhases.slice()
      : []
    if (!completed.includes('diva')) completed.push('diva')
    if (!completed.includes('sicct')) completed.push('sicct')
    req.session.data.completedSkinTestPhases = completed

    // Redistribute reactor IDs across the two phases using each saved
    // performedTest. Mirrors the per-animal end-of-loop redistribution
    // so the confirmation page shows the right per-test reactor counts.
    const allAnimals = getEntries(req)
    const finalSicct = []
    const finalDiva = []
    const initialReactorIds = new Set([
      ...getReactorsForPhase(req, 'sicct'),
      ...getReactorsForPhase(req, 'diva')
    ])
    const storedNow = req.session.data.skinTestEntries
    allAnimals.forEach(function (a, i) {
      if (!initialReactorIds.has(a.officialId)) return
      const e = storedNow[i] || {}
      if (e.performedTest === 'SICCT') finalSicct.push(a.officialId)
      else finalDiva.push(a.officialId)
    })
    setReactorsForPhase(req, 'sicct', finalSicct)
    setReactorsForPhase(req, 'diva', finalDiva)

    res.redirect(`/${version}/skin-test-all-tested`)
  })

  router.get(`/${version}/skin-test-diva/:index`, function (req, res) {
    // v1-2 has replaced the per-animal DIVA page with the tabular
    // /skin-test-diva-table view. Older versions keep the per-animal
    // loop so they still go through renderDivaMeasurement here.
    if ((version === 'v1-2' || isV13Plus(version))) {
      return res.redirect(`/${version}/${testTablePath}`)
    }
    const entries = getEntriesForPhase(req, 'diva')
    if (!entries.length) {
      if (!Array.isArray(req.session.data.skinTestReactors)) {
        return res.redirect(`/${version}/skin-test-reactors`)
      }
      return res.redirect(`/${version}/skin-test-all-tested`)
    }
    const index = Math.max(0, Math.min(parseInt(req.params.index, 10) || 0, entries.length - 1))
    req.session.data.currentDivaIndex = index
    req.session.data.currentSkinTestPhase = 'diva'
    renderDivaMeasurement(req, res, index)
  })

  router.post(`/${version}/skin-test-diva/:index`, function (req, res) {
    const entries = getEntriesForPhase(req, 'diva')
    if (!entries.length) {
      // No DIVA reactors – same fallback path as the SICCT guard.
      if (!Array.isArray(req.session.data.skinTestReactors)) {
        return res.redirect(`/${version}/skin-test-reactors`)
      }
      return res.redirect(`/${version}/skin-test-all-tested`)
    }

    const index = Math.max(0, Math.min(parseInt(req.params.index, 10) || 0, entries.length - 1))
    const loopAction = req.body.loopAction || 'next'

    // For v1-2 Both, the page is a unified measurement form for both
    // tests. The vet picks SICCT or DIVA at the top; the form fields
    // we save depend on that choice.
    const isBothJourney = req.session.data.skinTestType === 'Both'
    const isCombinedBoth = isBothJourney && (version === 'v1-2' || isV13Plus(version))
    const performedTestRaw = (req.body.performedTest || '').trim()
    const performedTest = (performedTestRaw === 'SICCT' || performedTestRaw === 'DIVA')
      ? performedTestRaw
      : null
    const recordingSicct = isCombinedBoth && performedTest === 'SICCT'

    // SICCT-only fields (used when the vet picked SICCT in the
    // combined Both flow).
    const avianBeforeInjection = (req.body.avianBeforeInjection || '').trim()
    const avianAfter72Hours = (req.body.avianAfter72Hours || '').trim()
    const bovineBeforeInjection = (req.body.bovineBeforeInjection || '').trim()
    const bovineAfter72Hours = (req.body.bovineAfter72Hours || '').trim()
    const reactionDescription = (req.body.reactionDescription || '').trim()
    const overallResult = (req.body.overallResult || '').trim()
    const sicctBatchUsed = (req.body.sicctBatchUsed || '').trim()

    // DIVA-only fields. When the vet picks SICCT in the combined flow
    // these stay blank and the existing DIVA fields on the entry are
    // cleared so a previous DIVA save doesn't bleed through.
    const divaBovineBeforeInjection = (req.body.divaBovineBeforeInjection || '').trim()
    const divaBovineAfter72Hours = (req.body.divaBovineAfter72Hours || '').trim()
    const divaReactionDescription = (req.body.divaReactionDescription || '').trim()
    const divaRemarks = (req.body.divaRemarks || '').trim()
    const divaResult = (req.body.divaResult || '').trim()
    const additionalNotes = (req.body.additionalNotes || '').trim()
    const divaBatchUsed = (req.body.divaBatchUsed || '').trim()

    // For v1-2 Both, the vet must pick which test was performed before
    // we save anything (other than save-exit / previous, which preserve
    // the in-progress state).
    if (isCombinedBoth
        && !performedTest
        && loopAction !== 'save-exit'
        && loopAction !== 'previous') {
      return renderDivaMeasurement(req, res, index, {
        formValues: {
          performedTest: performedTestRaw,
          avianBeforeInjection,
          avianAfter72Hours,
          bovineBeforeInjection,
          bovineAfter72Hours,
          reactionDescription,
          overallResult,
          sicctBatchUsed,
          divaBovineBeforeInjection,
          divaBovineAfter72Hours,
          divaReactionDescription,
          divaRemarks,
          divaResult,
          divaBatchUsed,
          additionalNotes
        },
        errors: { performedTest: { text: 'Select which test you did on this animal' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select which test you did on this animal', href: '#performedTest' }]
        }
      })
    }

    // When the vet recorded more than one DIVA batch on /skin-test-type
    // we ask which one was used for this animal. A single batch is
    // applied silently (no question is shown). The batch question only
    // applies when the vet is recording a DIVA reading.
    const divaBatchesList = (Array.isArray(req.session.data.skinTestDivaBatches)
      ? req.session.data.skinTestDivaBatches
      : []).map(function (b) { return (b || '').trim() }).filter(Boolean)
    const sicctBatchesList = (Array.isArray(req.session.data.skinTestSicctBatches)
      ? req.session.data.skinTestSicctBatches
      : []).map(function (b) { return (b || '').trim() }).filter(Boolean)

    const askingForDivaMeasurements = !isCombinedBoth || performedTest === 'DIVA'
    const askingForSicctMeasurements = isCombinedBoth && performedTest === 'SICCT'

    if (askingForDivaMeasurements
        && divaBatchesList.length > 1
        && loopAction !== 'save-exit'
        && loopAction !== 'previous'
        && !divaBatchUsed) {
      return renderDivaMeasurement(req, res, index, {
        formValues: {
          performedTest: performedTestRaw,
          avianBeforeInjection,
          avianAfter72Hours,
          bovineBeforeInjection,
          bovineAfter72Hours,
          reactionDescription,
          overallResult,
          sicctBatchUsed,
          divaBovineBeforeInjection,
          divaBovineAfter72Hours,
          divaReactionDescription,
          divaRemarks,
          divaResult,
          divaBatchUsed,
          additionalNotes
        },
        errors: { divaBatchUsed: { text: 'Select which DIVA batch was used for this animal' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select which DIVA batch was used for this animal', href: '#divaBatchUsed' }]
        }
      })
    }

    if (askingForSicctMeasurements
        && sicctBatchesList.length > 1
        && loopAction !== 'save-exit'
        && loopAction !== 'previous'
        && !sicctBatchUsed) {
      return renderDivaMeasurement(req, res, index, {
        formValues: {
          performedTest: performedTestRaw,
          avianBeforeInjection,
          avianAfter72Hours,
          bovineBeforeInjection,
          bovineAfter72Hours,
          reactionDescription,
          overallResult,
          sicctBatchUsed,
          divaBovineBeforeInjection,
          divaBovineAfter72Hours,
          divaReactionDescription,
          divaRemarks,
          divaResult,
          divaBatchUsed,
          additionalNotes
        },
        errors: { sicctBatchUsed: { text: 'Select which SICCT batch was used for this animal' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select which SICCT batch was used for this animal', href: '#sicctBatchUsed' }]
        }
      })
    }

    // Single batch case – record it automatically so the entry still
    // carries the batch number even though we didn't ask.
    const resolvedDivaBatchUsed = divaBatchesList.length === 1
      ? divaBatchesList[0]
      : divaBatchUsed
    const resolvedSicctBatchUsed = sicctBatchesList.length === 1
      ? sicctBatchesList[0]
      : sicctBatchUsed

    // Map the filtered DIVA-only index back to the full entries array.
    const targetOriginalIndex = entries[index] && entries[index].originalIndex
    const allAnimalsCount = getEntries(req).length

    // Persist the updated entry against the underlying animal.
    const stored = Array.isArray(req.session.data.skinTestEntries)
      ? [...req.session.data.skinTestEntries]
      : []
    while (stored.length < allAnimalsCount) {
      stored.push(blankEntry())
    }
    if (recordingSicct) {
      // SICCT was performed for this animal in the combined Both flow.
      // v1-2 no longer asks the vet for the overall SICCT result – it's
      // derived from the bovine-minus-avian increase between Day 1 and
      // Day 2 using the standard SICCT interpretation:
      //   bovine increase ≤ avian increase + 1 mm   → negative
      //   bovine increase between +1 and +4 mm     → inconclusive
      //   bovine increase > avian increase + 4 mm  → positive (reactor)
      // Older versions keep the vet-entered value untouched.
      let resolvedOverallResult = overallResult
      if ((version === 'v1-2' || isV13Plus(version))) {
        const aPre = parseFloat(avianBeforeInjection)
        const aPost = parseFloat(avianAfter72Hours)
        const bPre = parseFloat(bovineBeforeInjection)
        const bPost = parseFloat(bovineAfter72Hours)
        if (!isNaN(aPre) && !isNaN(aPost) && !isNaN(bPre) && !isNaN(bPost)) {
          const avianIncrease = aPost - aPre
          const bovineIncrease = bPost - bPre
          const diff = bovineIncrease - avianIncrease
          if (diff > 4) resolvedOverallResult = 'positive'
          else if (diff > 1) resolvedOverallResult = 'inconclusive'
          else resolvedOverallResult = 'negative'
        } else {
          resolvedOverallResult = ''
        }
      }
      // Save the SICCT measurements and clear any stale DIVA values.
      stored[targetOriginalIndex] = Object.assign({}, stored[targetOriginalIndex] || blankEntry(), {
        divaStatus: 'done',
        avianBeforeInjection,
        avianAfter72Hours,
        bovineBeforeInjection,
        bovineAfter72Hours,
        reactionDescription,
        overallResult: resolvedOverallResult,
        sicctBatchUsed: resolvedSicctBatchUsed,
        // Clear DIVA fields so a re-save after switching tests doesn't
        // leave both populated.
        divaBovineBeforeInjection: '',
        divaBovineAfter72Hours: '',
        divaReactionDescription: '',
        divaRemarks: '',
        divaResult: '',
        divaBatchUsed: '',
        additionalNotes,
        performedTest: 'SICCT'
      })
    } else {
      // Default DIVA save (single-test DIVA, v1-1 Both DIVA phase, or
      // v1-2 Both with the vet picking DIVA). v1-2 no longer shows the
      // result radio on the page – it's calculated from the change in
      // bovine skin thickness between Day 1 and Day 2:
      //   < 2 mm  → negative
      //   2–4 mm → inconclusive
      //   ≥ 4 mm  → positive
      // Older versions keep their vet-entered value untouched.
      let resolvedDivaResult = divaResult
      if ((version === 'v1-2' || isV13Plus(version))) {
        const pre = parseFloat(divaBovineBeforeInjection)
        const post = parseFloat(divaBovineAfter72Hours)
        if (!isNaN(pre) && !isNaN(post)) {
          const diff = post - pre
          if (diff >= 4) resolvedDivaResult = 'positive'
          else if (diff >= 2) resolvedDivaResult = 'inconclusive'
          else resolvedDivaResult = 'negative'
        } else {
          resolvedDivaResult = ''
        }
      }
      stored[targetOriginalIndex] = Object.assign({}, stored[targetOriginalIndex] || blankEntry(), {
        divaStatus: 'done',
        divaBovineBeforeInjection,
        divaBovineAfter72Hours,
        divaReactionDescription,
        divaRemarks,
        divaResult: resolvedDivaResult,
        divaBatchUsed: resolvedDivaBatchUsed,
        additionalNotes,
        performedTest: 'DIVA'
      })
    }
    req.session.data.skinTestEntries = stored

    // For v1-2 Both, all reactors stay on the DIVA phase list during
    // the loop so navigation back/next uses a stable iteration set.
    // The per-phase split is done once at the end of the loop (below)
    // by reading each entry's saved `performedTest`.

    if (loopAction === 'save-exit') {
      req.session.data.currentDivaIndex = index
      req.session.data.currentSkinTestPhase = 'diva'
      req.session.data.savedBanner = 'skin-test-report'
      req.session.data.skinTestInProgress = true
      return res.redirect(`/${version}/dashboard`)
    }

    if (loopAction === 'previous') {
      const previousIndex = Math.max(0, index - 1)
      req.session.data.currentDivaIndex = previousIndex
      return res.redirect(`/${version}/skin-test-diva/${previousIndex}`)
    }

    if (index < entries.length - 1) {
      const nextIndex = index + 1
      req.session.data.currentDivaIndex = nextIndex
      return res.redirect(`/${version}/skin-test-diva/${nextIndex}`)
    }

    // Last DIVA cattle saved. Mark the DIVA phase complete.
    req.session.data.currentDivaIndex = entries.length - 1
    const completed = Array.isArray(req.session.data.completedSkinTestPhases)
      ? req.session.data.completedSkinTestPhases.slice()
      : []
    if (!completed.includes('diva')) completed.push('diva')
    req.session.data.completedSkinTestPhases = completed

    // For v1-2 Both, redistribute the reactor IDs across SICCT and
    // DIVA phases now that the loop is finished, using each animal's
    // saved `performedTest`. This keeps the confirmation page's
    // per-test rows accurate without disturbing in-flight navigation.
    if (isCombinedBoth) {
      const allAnimals = getEntries(req)
      const finalSicct = []
      const finalDiva = []
      const reactorIds = getReactorsForPhase(req, 'diva')
      const reactorSet = new Set(reactorIds)
      const storedNow = Array.isArray(req.session.data.skinTestEntries)
        ? req.session.data.skinTestEntries
        : []
      allAnimals.forEach(function (a, i) {
        if (!reactorSet.has(a.officialId)) return
        const e = storedNow[i] || {}
        if (e.performedTest === 'SICCT') {
          finalSicct.push(a.officialId)
        } else {
          finalDiva.push(a.officialId)
        }
      })
      setReactorsForPhase(req, 'sicct', finalSicct)
      setReactorsForPhase(req, 'diva', finalDiva)
    }

    // For the v1-1 "Both" journey, hand off to the SICCT reactor flow
    // if it's still outstanding. v1-2's combined journey marks SICCT
    // complete on entry so this branch is skipped there.
    if (isBothJourney && !completed.includes('sicct')) {
      return res.redirect(`/${version}/skin-test-reactors-any`)
    }

    // All reactor measurements captured – on to the "were all of the
    // cattle tested?" question, which gates the mark-untested step.
    res.redirect(`/${version}/skin-test-all-tested`)
  })

  // Interim confirmation ------------------------------------------------------

  // A diagnostic page, not part of any journey: eight copies of the same
  // GOV.UK text input, each differing from the control by exactly one
  // thing, so a single pass with a screen reader says which difference
  // stops typing being announced. Guessing had cost six attempts by the
  // time this was written.
  router.get(`/${version}/typing-test`, function (req, res) {
    res.render(`${version}/typing-test`)
  })

  router.get(`/${version}/skin-test-confirmation`, function (req, res) {
    const entries = getEntries(req)
    const addedEntries = getAddedEntries(req)
    const allEntries = entries.concat(addedEntries)
    const summary = entrySummary(allEntries)

    // v1-2 captures a start time alongside the date for both Day 1 and
    // Day 2; the formatter falls back to date-only for older versions.
    let day1Formatted = formatDateTimeParts(
      req.session.data.skinTestDay1Day,
      req.session.data.skinTestDay1Month,
      req.session.data.skinTestDay1Year,
      req.session.data.skinTestDay1StartTimeHour,
      req.session.data.skinTestDay1StartTimeMinute,
      req.session.data.skinTestDay1StartTimeAmpm
    )
    let day2Formatted = formatDateTimeParts(
      req.session.data.skinTestDay2Day,
      req.session.data.skinTestDay2Month,
      req.session.data.skinTestDay2Year,
      req.session.data.skinTestDay2StartTimeHour,
      req.session.data.skinTestDay2StartTimeMinute,
      req.session.data.skinTestDay2StartTimeAmpm
    )
    const day2Calculated = req.session.data.skinTestDay2Calculated === 'yes'

    // v1-2 dummy fallback: when the vet skipped /v1-2/skin-test-date
    // (no Day 1 / Day 2 captured in session) seed sensible recent
    // dates so the confirmation page is demonstrable without forcing
    // data entry. Day 1 is 4 days ago, Day 2 is 1 day ago – exactly
    // 3 days apart (72 hours), matching the test's expected cadence.
    if ((version === 'v1-2' || isV13Plus(version))) {
      function formatDummyDateTime (d) {
        const dd = String(d.getDate()).padStart(2, '0')
        const mm = String(d.getMonth() + 1).padStart(2, '0')
        const yy = d.getFullYear()
        return `${dd}/${mm}/${yy} at 9:30 AM`
      }
      if (!day1Formatted) {
        const today = new Date()
        const dummy = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 4)
        day1Formatted = formatDummyDateTime(dummy)
      }
      if (!day2Formatted) {
        const today = new Date()
        const dummy = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
        day2Formatted = formatDummyDateTime(dummy)
      }
    }

    // One-shot: shown once, then cleared, so refreshing a fixed page does
    // not bring the error back.
    const declarationError = !!req.session.data.declarationError
    if (declarationError) req.session.data.declarationError = false

    // Consume the one-shot "added another" banner
    const addedAnotherEarTag = req.session.data.addedAnotherEarTag || null
    if (addedAnotherEarTag) {
      req.session.data.addedAnotherEarTag = null
    }

    const skinTestType = req.session.data.skinTestType || 'SICCT'
    const showSicct = skinTestType === 'SICCT' || skinTestType === 'Both'
    const showDiva  = skinTestType === 'DIVA'  || skinTestType === 'Both'
    const divaStats = divaSummary(allEntries)

    // Reactor / untested / clear breakdown for the new reporting flow.
    // For "Both", we read SICCT and DIVA reactors separately so the
    // confirmation page can list them in their own sections.
    const isBoth = skinTestType === 'Both'
    const isCombinedBoth = isBoth && (version === 'v1-2' || isV13Plus(version))
    let sicctReactorIds = getReactorsForPhase(req, 'sicct')
    let divaReactorIds = getReactorsForPhase(req, 'diva')
    // For v1-2 Both, the per-animal `performedTest` is the source of
    // truth for which list each reactor belongs in. Derive the per-
    // test reactor IDs from saved entries so the confirmation page is
    // accurate even if the loop hasn't finished (and therefore the
    // end-of-loop redistribute hasn't run yet).
    if (isCombinedBoth) {
      const allReactorIds = Array.from(new Set([...sicctReactorIds, ...divaReactorIds]))
      const allReactorSet = new Set(allReactorIds)
      const derivedSicct = []
      const derivedDiva = []
      entries.forEach(function (e) {
        if (!allReactorSet.has(e.officialId)) return
        if (e.performedTest === 'SICCT') {
          derivedSicct.push(e.officialId)
        } else if (e.performedTest === 'DIVA') {
          derivedDiva.push(e.officialId)
        } else {
          // Reactor that hasn't been recorded yet – fall back to the
          // recommended test based on vaccination status so the
          // confirmation page still bins them sensibly while the
          // vet's mid-flow.
          if (e.isVaccinated) derivedDiva.push(e.officialId)
          else derivedSicct.push(e.officialId)
        }
      })
      sicctReactorIds = derivedSicct
      divaReactorIds = derivedDiva
    }
    const combinedReactorIds = Array.from(new Set([...sicctReactorIds, ...divaReactorIds]))

    const untestedIds = Array.isArray(req.session.data.skinTestUntested)
      ? req.session.data.skinTestUntested
      : []
    const reactorSet = new Set(combinedReactorIds)
    const untestedSet = new Set(untestedIds)
    const reactorEntries = allEntries.filter(e => reactorSet.has(e.officialId))
    const sicctReactorEntries = allEntries.filter(e => sicctReactorIds.indexOf(e.officialId) !== -1)
    const divaReactorEntries = allEntries.filter(e => divaReactorIds.indexOf(e.officialId) !== -1)
    const untestedReasons = req.session.data.skinTestUntestedReasons || {}
    // v1-3: animals still to test ("Could not be managed" or "Missing on
    // day 2") are not "not tested" - they're still to test, and they make
    // this a part test. Keep them out of the terminal "Not tested" count.
    const returnVisitSet = new Set(untestedIds.filter(function (id) { return isStillToTestReason(untestedReasons[id]) }))
    const untestedEntries = allEntries.filter(e => untestedSet.has(e.officialId) && !reactorSet.has(e.officialId) && !returnVisitSet.has(e.officialId))
    const stillToTestEntries = (isV13Plus(version))
      ? allEntries.filter(e => returnVisitSet.has(e.officialId) && !reactorSet.has(e.officialId))
      : []
    const isPartTest = isV13Plus(version) && stillToTestEntries.length > 0
    const clearEntries = allEntries.filter(e => !reactorSet.has(e.officialId) && !untestedSet.has(e.officialId))

    // Batch numbers captured on /skin-test-type. Filter blanks so the
    // confirmation page only lists batches the vet actually entered.
    const sicctBatches = (Array.isArray(req.session.data.skinTestSicctBatches)
      ? req.session.data.skinTestSicctBatches
      : []).map(function (b) { return (b || '').trim() }).filter(Boolean)
    const divaBatches = (Array.isArray(req.session.data.skinTestDivaBatches)
      ? req.session.data.skinTestDivaBatches
      : []).map(function (b) { return (b || '').trim() }).filter(Boolean)

    res.render(`${version}/skin-test-confirmation`, {
      entries: allEntries,
      entriesSummary: summary,
      divaSummary: divaStats,
      skinTestType,
      showSicct,
      showDiva,
      day1Formatted,
      day2Formatted,
      day2Calculated,
      addedAnotherEarTag,
      reactorEntries,
      sicctReactorEntries,
      divaReactorEntries,
      untestedEntries,
      clearEntries,
      untestedReasons,
      addedEntries,
      reactorCount: reactorEntries.length,
      sicctReactorCount: sicctReactorEntries.length,
      divaReactorCount: divaReactorEntries.length,
      untestedCount: untestedEntries.length,
      stillToTestCount: stillToTestEntries.length,
      isPartTest: isPartTest,
      clearCount: clearEntries.length,
      addedCount: addedEntries.length,
      isBothJourney: isBoth,
      sicctBatches,
      divaBatches,
      checkList: version === 'v1-4' ? v14CheckList(req) : [],
      // The same page, reached two ways. A vet who uploaded a file is
      // checking the file against the yard; a vet who typed the results in
      // is checking their typing against the paper. Back and the opening
      // line differ; everything else is the same check.
      fromDevice: req.session.data.recordMethod === 'device',
      declarationError: declarationError,
      declarationConfirmed: req.session.data.skinTestDeclaration === 'confirmed'
    })
  })

  router.post(`/${version}/skin-test-confirmation`, function (req, res) {
    // v1-4 carries its declaration on this page rather than on a page of
    // its own, so nothing can be submitted until it is ticked. The error
    // is handed back through the session and shown by the GET, which
    // already builds every local this page needs - re-rendering here
    // would mean assembling all of them a second time.
    if (version === 'v1-4') {
      // The Prototype Kit posts a hidden "_unchecked" value for every
      // checkbox, so an unticked box arrives as the string "_unchecked"
      // rather than as nothing at all. Testing for truthiness would let
      // an unticked declaration straight through.
      const declared = [].concat(req.body.declaration || [])
        .indexOf('confirmed') !== -1
      if (!declared) {
        req.session.data.declarationError = true
        return res.redirect(`/${version}/skin-test-confirmation#declaration-error`)
      }
      req.session.data.declarationError = false
      req.session.data.skinTestDeclaration = 'confirmed'
    }
    // v1-2 puts the "are there more cattle to add?" question BEFORE the
    // review page, so the confirmation page's "Submit" button submits
    // the report directly. v1-1 keeps the original ordering – Continue
    // here goes to the add-cattle-question gate, then on to submit.
    if ((version === 'v1-2' || isV13Plus(version))) {
      req.session.data.skinTestInProgress = false
      return res.redirect(`/${version}/skin-test-submitted`)
    }
    res.redirect(`/${version}/skin-test-add-cattle-question`)
  })

  // --- "Are there more cattle to add?" yes/no -------------------------
  router.get(`/${version}/skin-test-add-cattle-question`, function (req, res) {
    res.render(`${version}/skin-test-add-cattle-question`)
  })

  router.post(`/${version}/skin-test-add-cattle-question`, function (req, res) {
    const addMoreCattle = req.body.addMoreCattle
    req.session.data.addMoreCattle = addMoreCattle

    if (addMoreCattle !== 'yes' && addMoreCattle !== 'no') {
      return res.render(`${version}/skin-test-add-cattle-question`, {
        errors: { addMoreCattle: { text: 'Select yes if there are more cattle to add, or no to submit the report' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select yes if there are more cattle to add, or no to submit the report', href: '#addMoreCattle' }]
        }
      })
    }

    if (addMoreCattle === 'yes') {
      return res.redirect(`/${version}/skin-test-add-another`)
    }

    // No more cattle to add. v1-2 sits this question between the
    // "all tested?" gate and the final review page, so "no" continues
    // on to the confirmation page rather than submitting outright.
    // v1-1 keeps the original "no = submit" behaviour.
    if ((version === 'v1-2' || isV13Plus(version))) {
      return res.redirect(`/${version}/skin-test-confirmation`)
    }
    req.session.data.skinTestInProgress = false
    res.redirect(`/${version}/skin-test-submitted`)
  })

  // Add another animal --------------------------------------------------------

  router.get(`/${version}/skin-test-add-another`, function (req, res) {
    res.render(`${version}/skin-test-add-another`, { formValues: {}, breedItems: buildBreedItems('') })
  })

  router.post(`/${version}/skin-test-add-another`, function (req, res) {
    const earTag = (req.body.earTag || '').trim()
    const breed = (req.body.breed || '').trim()
    const sex = (req.body.addedSex || '').trim()
    const dobDay = (req.body['addedDob-day'] || '').trim()
    const dobMonth = (req.body['addedDob-month'] || '').trim()
    const dobYear = (req.body['addedDob-year'] || '').trim()
    const dob = (dobDay && dobMonth && dobYear) ? `${dobDay}/${dobMonth}/${dobYear}` : ''

    const formValues = {
      earTag,
      breed,
      addedSex: sex,
      addedDobDay: dobDay,
      addedDobMonth: dobMonth,
      addedDobYear: dobYear,
      remarks: (req.body.remarks || '').trim()
    }

    if (!earTag) {
      return res.render(`${version}/skin-test-add-another`, {
        formValues,
        breedItems: buildBreedItems(formValues.breed),
        errors: { earTag: { text: 'Enter the ear tag number' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Enter the ear tag number', href: '#earTag' }]
        }
      })
    }

    const added = Array.isArray(req.session.data.skinTestAddedEntries)
      ? [...req.session.data.skinTestAddedEntries]
      : []

    added.push({
      officialId: earTag,
      earTag,
      breed,
      sex,
      dob,
      // The page no longer captures measurements – the added animal
      // is just a record of "this animal exists on the farm and
      // wasn't on the original list" with the basic identifiers and
      // any free-text remarks the vet wants to leave.
      status: 'done',
      remarks: formValues.remarks
    })

    req.session.data.skinTestAddedEntries = added
    req.session.data.addedAnotherEarTag = earTag
    res.redirect(`/${version}/skin-test-added-cattle`)
  })

  // Standard GOV.UK "add another" summary. After adding an animal the vet
  // lands here: a list of everything added so far (each with a Change /
  // remove action via the edit page), and a "Do you need to add another
  // animal?" question that either loops back to the form or continues to
  // the final review.
  router.get(`/${version}/skin-test-added-cattle`, function (req, res) {
    const addedEntries = getAddedEntries(req)
    res.render(`${version}/skin-test-added-cattle`, {
      addedEntries,
      addedCount: addedEntries.length
    })
    // Show the "Added X" success banner once, then clear it so it doesn't
    // reappear on the final confirmation page.
    req.session.data.addedAnotherEarTag = null
  })

  router.post(`/${version}/skin-test-added-cattle`, function (req, res) {
    const addAnotherAnimal = req.body.addAnotherAnimal
    if (addAnotherAnimal !== 'yes' && addAnotherAnimal !== 'no') {
      const addedEntries = getAddedEntries(req)
      return res.render(`${version}/skin-test-added-cattle`, {
        addedEntries,
        addedCount: addedEntries.length,
        errors: { addAnotherAnimal: { text: 'Select yes if you need to add another animal, or no to continue' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Select yes if you need to add another animal, or no to continue', href: '#addAnotherAnimal' }]
        }
      })
    }
    if (addAnotherAnimal === 'yes') {
      return res.redirect(`/${version}/skin-test-add-another`)
    }
    res.redirect(`/${version}/skin-test-confirmation`)
  })

  // Final submission ----------------------------------------------------------

  router.get(`/${version}/skin-test-submitted`, function (req, res) {
    const entries = getEntries(req)
    const addedEntries = getAddedEntries(req)
    const allEntries = entries.concat(addedEntries)
    const summary = entrySummary(allEntries)

    let day1Formatted = formatDateTimeParts(
      req.session.data.skinTestDay1Day,
      req.session.data.skinTestDay1Month,
      req.session.data.skinTestDay1Year,
      req.session.data.skinTestDay1StartTimeHour,
      req.session.data.skinTestDay1StartTimeMinute,
      req.session.data.skinTestDay1StartTimeAmpm
    )
    let day2Formatted = formatDateTimeParts(
      req.session.data.skinTestDay2Day,
      req.session.data.skinTestDay2Month,
      req.session.data.skinTestDay2Year,
      req.session.data.skinTestDay2StartTimeHour,
      req.session.data.skinTestDay2StartTimeMinute,
      req.session.data.skinTestDay2StartTimeAmpm
    )
    const day2Calculated = req.session.data.skinTestDay2Calculated === 'yes'

    // v1-2 dummy fallback – mirrors the same logic on
    // /v1-2/skin-test-confirmation so the submitted page reads the
    // same dates the vet just signed off. Day 1 = 4 days ago, Day 2
    // = 1 day ago (72 hours apart).
    if ((version === 'v1-2' || isV13Plus(version))) {
      function formatDummyDateTime (d) {
        const dd = String(d.getDate()).padStart(2, '0')
        const mm = String(d.getMonth() + 1).padStart(2, '0')
        const yy = d.getFullYear()
        return `${dd}/${mm}/${yy} at 9:30 AM`
      }
      if (!day1Formatted) {
        const today = new Date()
        const dummy = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 4)
        day1Formatted = formatDummyDateTime(dummy)
      }
      if (!day2Formatted) {
        const today = new Date()
        const dummy = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
        day2Formatted = formatDummyDateTime(dummy)
      }
    }

    // Mirror the breakdown the confirmation page shows so the vet
    // sees the same summary they signed off on.
    const reactorIds = Array.isArray(req.session.data.skinTestReactors)
      ? req.session.data.skinTestReactors
      : []
    const untestedIds = Array.isArray(req.session.data.skinTestUntested)
      ? req.session.data.skinTestUntested
      : []
    const reactorSet = new Set(reactorIds)
    const untestedSet = new Set(untestedIds)
    const untestedReasons = req.session.data.skinTestUntestedReasons || {}
    // v1-3: still-to-test animals ("Could not be managed" or "Missing on
    // day 2") are not terminal "not tested" - keep them separate (they
    // make this a part test).
    const returnVisitSet = new Set(untestedIds.filter(function (id) { return isStillToTestReason(untestedReasons[id]) }))
    const reactorEntries = allEntries.filter(e => reactorSet.has(e.officialId))
    const untestedEntries = allEntries.filter(e => untestedSet.has(e.officialId) && !reactorSet.has(e.officialId) && !returnVisitSet.has(e.officialId))
    const stillToTestEntries = (isV13Plus(version))
      ? allEntries.filter(e => returnVisitSet.has(e.officialId) && !reactorSet.has(e.officialId))
      : []
    const clearCount = allEntries.length - reactorEntries.length - untestedEntries.length - stillToTestEntries.length

    // Once the user has seen the final confirmation, the report is no longer in progress
    req.session.data.skinTestInProgress = false

    // Drop the prepared-list record for this farm so the dashboard
    // stops offering "Report skin test results" once it's been done.
    const submittedCph = req.session.data.herd && req.session.data.herd.cph
    if (submittedCph && Array.isArray(req.session.data.skinTestListPrepared)) {
      req.session.data.skinTestListPrepared = req.session.data.skinTestListPrepared.filter(function (r) {
        return r && r.cph !== submittedCph
      })
    }
    // Stop the v1-2 Mill House Farm demo seed from re-introducing the
    // prepared-list record after the vet has filed the report.
    if ((version === 'v1-2' || isV13Plus(version)) && submittedCph === '12/312/6802') {
      req.session.data.millHouseSkinTestSubmitted = true
    }

    // v1-3 part test: some animals are still to be tested on a return
    // visit, so the herd's test stays open. Record it against the herd
    // so the dashboard can offer "Test remaining cattle".
    const stillToTestCountSubmitted = stillToTestEntries.length
    const isPartTestSubmitted = isV13Plus(version) && stillToTestCountSubmitted > 0
    if (isV13Plus(version) && submittedCph) {
      const partTests = Object.assign({}, req.session.data.skinTestPartTests || {})
      if (isPartTestSubmitted) {
        // Some animals are still to test, so keep the herd's test open and
        // record exactly which animals are outstanding. The return-visit
        // print list and report are scoped to these IDs.
        partTests[submittedCph] = {
          cph: submittedCph,
          farm: (req.session.data.herd && req.session.data.herd.farm) || 'Selected farm',
          stillToTest: stillToTestCountSubmitted,
          remainingIds: stillToTestEntries.map(function (e) { return e.officialId }),
          testType: req.session.data.skinTestType || null,
          submittedAt: new Date().toISOString()
        }
        // A part test is not the herd's final report, so don't let the
        // demo seed treat Mill House as fully submitted.
        if (submittedCph === '12/312/6802') {
          req.session.data.millHouseSkinTestSubmitted = false
        }
      } else if (partTests[submittedCph]) {
        // This was a return visit that tested every remaining animal, so
        // the part test is now complete – drop it from the work list.
        delete partTests[submittedCph]
      }
      req.session.data.skinTestPartTests = partTests

      // A completed skin test (no animals still to test) moves off the work
      // list and into the dashboard's "Recently completed" section.
      if (!isPartTestSubmitted) {
        recordCompletedReport(req, {
          cph: submittedCph,
          farm: (req.session.data.herd && req.session.data.herd.farm) || 'Selected farm',
          type: 'skin-test',
          typeLabel: 'Skin test report',
          snapshot: snapshotSkinTestReport(req)
        })
      }
    }
    // Clear any return-visit scope so the next report covers the full herd.
    req.session.data.skinTestScopeIds = null

    res.render(`${version}/skin-test-submitted`, {
      entriesSummary: summary,
      day1Formatted,
      day2Formatted,
      day2Calculated,
      reactorEntries,
      untestedEntries,
      addedEntries,
      reactorCount: reactorEntries.length,
      untestedCount: untestedEntries.length,
      addedCount: addedEntries.length,
      clearCount,
      untestedReasons,
      isPartTest: isPartTestSubmitted,
      stillToTestCount: stillToTestCountSubmitted,
      // What happens next depends on what was actually recorded, so the
      // submitted page needs the same read of the results the vet just
      // signed off - not the raw reactor list, which does not know
      // whether a reading came out as a reactor or a pass.
      submittedOutcomes: version === 'v1-4'
        ? (function () {
            const rows = v14CheckList(req)
            const reacted = rows.filter(function (r) {
              return r.outcome === 'reactor' || r.outcome === 'inconclusive'
            })
            const dead = rows.filter(function (r) {
              return r.status === 'not-tested' && r.reasonLabel === 'Dead'
            })
            return {
              reacted: reacted.length,
              reactedIds: reacted.map(function (r) { return r.officialId }),
              dead: dead.length,
              deadIds: dead.map(function (r) { return r.officialId })
            }
          })()
        : null
    })
  })

  // Remove an animal that was previously added on /skin-test-add-another.
  // Kept for the legacy "Remove" link – the new flow uses the edit
  // route below, where Remove is a button on the edit form itself.
  router.post(`/${version}/skin-test-add-another/remove`, function (req, res) {
    const earTag = (req.body.earTag || '').trim()
    const added = Array.isArray(req.session.data.skinTestAddedEntries)
      ? req.session.data.skinTestAddedEntries
      : []
    req.session.data.skinTestAddedEntries = added.filter(function (e) {
      return e.officialId !== earTag
    })
    res.redirect(`/${version}/skin-test-added-cattle`)
  })

  // Edit (or remove) an animal that was previously added on
  // /skin-test-add-another. Reached from the "Change" action next to
  // each added animal on the confirmation page. Reuses the
  // skin-test-add-another form template in edit mode so the same
  // fields are available.
  router.get(`/${version}/skin-test-add-another/edit/:earTag`, function (req, res) {
    const earTag = req.params.earTag
    const added = Array.isArray(req.session.data.skinTestAddedEntries)
      ? req.session.data.skinTestAddedEntries
      : []
    const entry = added.find(function (e) { return e.officialId === earTag })
    if (!entry) {
      return res.redirect(`/${version}/skin-test-confirmation`)
    }
    const dobParts = (entry.dob || '').split('/')
    res.render(`${version}/skin-test-add-another`, {
      isEditMode: true,
      originalEarTag: earTag,
      breedItems: buildBreedItems(entry.breed || ''),
      formValues: {
        earTag: entry.earTag || entry.officialId,
        breed: entry.breed || '',
        addedSex: entry.sex || '',
        addedDobDay: dobParts[0] || '',
        addedDobMonth: dobParts[1] || '',
        addedDobYear: dobParts[2] || '',
        remarks: entry.remarks || ''
      }
    })
  })

  router.post(`/${version}/skin-test-add-another/edit/:earTag`, function (req, res) {
    const originalEarTag = req.params.earTag
    const added = Array.isArray(req.session.data.skinTestAddedEntries)
      ? [...req.session.data.skinTestAddedEntries]
      : []
    const idx = added.findIndex(function (e) { return e.officialId === originalEarTag })

    // "Remove" button on the edit form posts addedAction=remove. The
    // animal is dropped from the report and the vet returns to the
    // confirmation page.
    if (req.body.addedAction === 'remove') {
      if (idx >= 0) {
        added.splice(idx, 1)
        req.session.data.skinTestAddedEntries = added
      }
      return res.redirect(`/${version}/skin-test-confirmation`)
    }

    // Standard save – validate ear tag, then update the entry in place.
    const earTag = (req.body.earTag || '').trim()
    const breed = (req.body.breed || '').trim()
    const sex = (req.body.addedSex || '').trim()
    const dobDay = (req.body['addedDob-day'] || '').trim()
    const dobMonth = (req.body['addedDob-month'] || '').trim()
    const dobYear = (req.body['addedDob-year'] || '').trim()
    const dob = (dobDay && dobMonth && dobYear) ? `${dobDay}/${dobMonth}/${dobYear}` : ''
    const remarks = (req.body.remarks || '').trim()

    const formValues = {
      earTag,
      breed,
      addedSex: sex,
      addedDobDay: dobDay,
      addedDobMonth: dobMonth,
      addedDobYear: dobYear,
      remarks
    }

    if (!earTag) {
      return res.render(`${version}/skin-test-add-another`, {
        isEditMode: true,
        originalEarTag,
        formValues,
        breedItems: buildBreedItems(formValues.breed),
        errors: { earTag: { text: 'Enter the ear tag number' } },
        errorSummary: {
          titleText: 'There is a problem',
          errorList: [{ text: 'Enter the ear tag number', href: '#earTag' }]
        }
      })
    }

    if (idx >= 0) {
      added[idx] = Object.assign({}, added[idx], {
        officialId: earTag,
        earTag,
        breed,
        sex,
        dob,
        remarks
      })
      req.session.data.skinTestAddedEntries = added
    }
    res.redirect(`/${version}/skin-test-confirmation`)
  })
}

// ---------------------------------------------------------------------
// "Check data" - the journey in front of the recording screens.
//
// Most tests are recorded on a third-party handheld and arrive as a file;
// the rest are written on paper and typed in afterwards. Everything after
// this point differs, so it is the first question rather than a setting
// found later. Research also found the two manual shapes suit different
// jobs - a whole herd is mostly one answer repeated, a pre-movement is a
// handful of named animals - so the manual path forks again.
//
// Version-free on purpose: this sits above the versioned prototypes and
// routes into them.
// ---------------------------------------------------------------------

// The problems a file from a device can arrive with. Every one of these
// came out of research; none of them are handled anywhere in the service
// today, which is the point of showing them.
router.get('/record-results', function (req, res) {
  res.render('record-results')
})

router.post('/record-results', function (req, res) {
  const method = (req.body.method || '').trim()
  if (method !== 'device' && method !== 'paper') {
    return res.render('record-results', {
      // Matches the question. An error that rephrases the thing the vet
      // just failed to answer makes them read both and work out they are
      // the same question.
      errors: { method: 'Select how you recorded the results' }
    })
  }
  req.session.data.recordMethod = method
  // Switching to paper after trying the device path starts from nothing -
  // otherwise the paper task list opens with the device's results already
  // in it, which is the opposite of what the vet asked for.
  if (method === 'paper' && req.session.data.deviceImportSeeded === 'yes') {
    req.session.data.skinTestUntested = []
    req.session.data.skinTestUntestedReasons = {}
    req.session.data.skinTestReactorsByPhase = {}
    req.session.data.skinTestReviewStatuses = {}
    req.session.data.recordRestConfirmed = null
    req.session.data.deviceImportSeeded = null
  }
  return res.redirect(method === 'device'
    ? '/record-results-upload'
    : '/record-results-type')
})

router.get('/record-results-upload', function (req, res) {
  res.render('record-results-upload')
})

router.post('/record-results-upload', function (req, res) {
  // The file is not read. A fixed set of results is loaded instead, so the
  // checking task can be tested without a device to hand.
  if (recordSeedSession) { recordSeedSession(req, res) }
  seedDeviceImport(req)

  // Straight to check and send. The import arrives complete - every animal
  // already has a result - so there is no work to list, and a task list in
  // front of a finished file is a page the vet clicks past. What they
  // actually have to do is read the results, which is this page.
  //
  // Task mode is turned off rather than left as it was: it draws a "Return
  // to the task list" bar across the top of every screen, and on this path
  // there is no task list to return to.
  req.session.data.recordTaskMode = null
  req.session.data.recordTaskSection = null
  req.session.data.recordTaskHome = null
  req.session.data.recordTaskReturn = null

  res.redirect('/v1-4/skin-test-confirmation')
})

// Readings as they would arrive from a handheld: the same shape as the
// printed sheet's demo readings, but plain numbers rather than the
// handwriting markup buildDemo produces. Deterministic per animal, so the
// same tag always shows the same figures across reloads.
function deviceReadings(officialId, role) {
  let h = 2166136261
  const sid = String(officialId)
  for (let i = 0; i < sid.length; i++) { h ^= sid.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  const rnd = function (n) { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return Math.floor((h / 4294967296) * n) }
  const aPre = 4 + rnd(5)
  const bPre = 4 + rnd(5)
  let bPost = bPre
  if (role === 'reactor') bPost = bPre + 6 + rnd(6)
  else if (role === 'inconclusive') bPost = bPre + 4
  return {
    avianBeforeInjection: String(aPre),
    avianAfter72Hours: String(aPre),
    bovineBeforeInjection: String(bPre),
    bovineAfter72Hours: String(bPost),
    avianOedema: 'C',
    bovineOedema: 'C'
  }
}

// The tag number physically applied to a reactor. Only a reactor gets one
// - an inconclusive animal stays on the farm to be retested.
function deviceReactorRef(officialId) {
  let h = 5381
  const sid = String(officialId)
  for (let i = 0; i < sid.length; i++) { h = ((h * 33) ^ sid.charCodeAt(i)) >>> 0 }
  return String(100 + (h % 900))
}

// The reason a device import would carry for each kind of untested animal,
// in the same vocabulary the vet picks from on the reason screen. An
// animal the handheld has no reading for is not "unexplained" - the herd
// record already says why - so the import arrives with the reason filled
// in and the vet is checking it rather than supplying it.
const DEVICE_IMPORT_REASONS = {
  'not-presented': 'not-presented',
  dead: 'dead',
  'recent-test': 'not-eligible',
  'under-age': 'not-eligible'
}

// Fill the same session state the paper journey writes, from what the
// device sent. Guarded, so a vet who goes into a task and changes
// something does not have it overwritten by a revisit to this page.
function seedDeviceImport(req) {
  const data = req.session.data
  if (data.deviceImportSeeded === 'yes') return
  const animals = getAnimalsForSelection('12/312/6802', 'v1-4') || []

  const untested = []
  const reasons = Object.assign({}, data.skinTestUntestedReasons || {})
  const reacted = []
  animals.forEach(function (a) {
    const reason = DEVICE_IMPORT_REASONS[a.demoRole]
    if (reason) {
      untested.push(a.officialId)
      reasons[a.officialId] = reason
    } else if (a.demoRole === 'reactor' || a.demoRole === 'inconclusive') {
      reacted.push(a.officialId)
    }
  })

  data.skinTestUntested = untested
  data.skinTestUntestedReasons = reasons
  data.skinTestReactorsByPhase = Object.assign({}, data.skinTestReactorsByPhase || {}, { sicct: reacted })

  // The readings themselves. A handheld sends the four figures, not just
  // "this one reacted" - without them the review reads "Readings missing"
  // for every animal, which is true of the session but false of the file.
  const idx = recordEntryIndex ? recordEntryIndex(req) : null
  if (idx) {
    const entries = Array.isArray(data.skinTestEntries) ? data.skinTestEntries.slice() : []
    animals.forEach(function (a) {
      if (a.demoRole !== 'reactor' && a.demoRole !== 'inconclusive') return
      const at = idx.get(a.officialId)
      if (typeof at !== 'number') return
      const m = deviceReadings(a.officialId, a.demoRole)
      entries[at] = Object.assign({}, entries[at] || {}, m, {
        reactorReference: a.demoRole === 'reactor' ? deviceReactorRef(a.officialId) : ''
      })
    })
    data.skinTestEntries = entries
  }
  // The device reports the rest as tested with no reaction. That is the
  // claim the vet is being asked to check, so it arrives made rather than
  // as a job still to do.
  data.recordRestConfirmed = 'yes'
  data.deviceImportSeeded = 'yes'
}

router.get('/record-results-check', function (req, res) {
  if (recordSeedSession) { recordSeedSession(req, res) }
  seedDeviceImport(req)
  req.session.data.recordTaskMode = 'yes'
  req.session.data.recordTaskSection = null
  req.session.data.recordTaskHome = '/record-results-check'
  const animals = getAnimalsForSelection('12/312/6802', 'v1-4') || []

  res.render('record-results-check', {
    deviceName: 'TB Master',
    received: animals.length,
    task: recordTaskState(req)
  })
})

// Assigned by registerSkinTestRoutes below, at load time and before any
// request is served.
let recordSeedSession = null
let recordCheckList = null
let recordEntryIndex = null
let recordSaveAnimal = null
let recordReasons = null

router.get('/record-results-type', function (req, res) {
  res.render('record-results-type')
})

router.post('/record-results-type', function (req, res) {
  const shape = (req.body.testShape || '').trim()
  if (shape !== 'herd' && shape !== 'selected') {
    return res.render('record-results-type', {
      errors: { testShape: 'Select what you are recording' }
    })
  }
  req.session.data.recordShape = shape
  // A whole herd goes to the task list, which lets the vet work by
  // category the way research says they do; a handful of named cattle goes
  // straight to add-another, where naming each one is the whole job.
  return res.redirect(shape === 'herd'
    ? '/record-results-tasks'
    : '/v1-5/skin-test-reactions')
})

// Work out where the vet has got to, from what they have actually
// recorded. Nothing is marked done by visiting a page - the counts are the
// progress, which is what P1 asked for: "I like to see my list whittling
// down in front of me."
function recordTaskState(req) {
  // Every task on this list hands off to a screen that expects the Mill
  // House herd in session. Seeding here means the vet can land on the task
  // list cold - from a bookmark, or a cleared session - and still get the
  // same 102 cattle the rest of the journey uses.
  if (recordSeedSession) { recordSeedSession(req, null) }

  const data = req.session.data || {}
  const animals = getAnimalsForSelection('12/312/6802', 'v1-4') || []

  const untestedIds = Array.isArray(data.skinTestUntested) ? data.skinTestUntested : []
  const reasons = data.skinTestUntestedReasons || {}
  const untestedWithReason = untestedIds.filter(function (id) { return !!reasons[id] })

  const byPhase = data.skinTestReactorsByPhase || {}
  const statuses = data.skinTestReviewStatuses || {}
  const reacted = new Set(
    [].concat(byPhase.sicct || [], byPhase.diva || [])
      .concat(Object.keys(statuses).filter(function (k) { return statuses[k] === 'reaction' }))
  )

  const named = new Set([].concat(untestedIds, Array.from(reacted)))
  const rest = Math.max(animals.length - named.size, 0)

  // Added cattle are not part of the printed 102, so they never change the
  // "accounted for" sum - they are their own task with their own count.
  const added = Array.isArray(data.skinTestAddedEntries) ? data.skinTestAddedEntries : []

  // Confirming the rest is a decision the vet makes, not something we can
  // infer - so it is held as its own answer. If they name more animals
  // afterwards the confirmation still stands for whatever is left, which is
  // why the count is recomputed each time rather than stored.
  const restConfirmed = data.recordRestConfirmed === 'yes'

  return {
    total: animals.length,
    untestedCount: untestedIds.length,
    untestedNeedingReason: untestedIds.length - untestedWithReason.length,
    reactedCount: reacted.size,
    addedCount: added.length,
    named: named.size,
    rest: rest,
    restConfirmed: restConfirmed,
    accountedFor: restConfirmed ? animals.length : named.size,
    remaining: restConfirmed ? 0 : rest
  }
}

router.get('/record-results-tasks', function (req, res) {
  req.session.data.recordTaskMode = 'yes'
  req.session.data.recordTaskSection = null
  req.session.data.recordTaskHome = '/record-results-tasks'
  res.render('record-results-tasks', { task: recordTaskState(req) })
})

// Every task link goes through here, so the app knows which section the
// vet is in and where that section ends. See RECORD_TASK_SECTIONS.
router.get('/record-results-task/:section', function (req, res) {
  const key = req.params.section
  const section = RECORD_TASK_SECTIONS[key]
  if (!section) return res.redirect('/record-results-tasks')
  req.session.data.recordTaskMode = 'yes'
  req.session.data.recordTaskSection = key

  // A task with nothing in it opens on the screen that puts something in
  // it. A task that already has something opens on what it has. Clicking
  // "25 recorded" and landing on a 102-row picker with empty checkboxes
  // is the service asking the vet to do the job again.
  const task = recordTaskState(req)
  const done = {
    untested: task.untestedCount,
    reactions: task.reactedCount,
    'add-cattle': task.addedCount
  }[key] || 0

  res.redirect((section.review && done > 0) ? section.review : section.entry)
})

// One row per animal in a section, so the vet can read back what is
// recorded and change any of it. The rows come from the same builder the
// check-and-send page uses, so a reason or a set of readings reads the
// same wherever it appears.
const RECORD_REVIEWS = {
  untested: {
    heading: "Cattle that couldn't be tested",
    lead: 'Check the reason given for each one. You can change any of them.',
    // Add-another, not the bulk picker: naming one animal is a different
    // job from choosing a set out of 102.
    addHref: '/record-results-add/untested',
    addText: 'Add another animal that could not be tested',
    status: 'not-tested'
  },
  reactions: {
    heading: 'Cattle that reacted',
    lead: 'Check the four readings for each one. You can change any of them.',
    addHref: '/v1-5/skin-test-reactions',
    addText: 'Add another animal that reacted',
    status: 'reaction'
  }
}

// A single animal's record, on its own page. The review lists link here
// rather than into the 102-row table: a vet who clicks Change on one
// animal is asking to edit that animal, not to find it again in a list.
const RECORD_EDIT_STATUSES = ['clear', 'reaction', 'not-tested']

function recordEditRow(req, officialId) {
  const rows = recordCheckList ? recordCheckList(req) : []
  return rows.filter(function (r) { return r.officialId === officialId })[0] || null
}

// Where "Save and return" returns to. Three callers now open this screen -
// the two section reviews and the check-and-send page - and a vet who
// clicked Change on line 47 of the check list expects to land back on line
// 47 of the check list, not on a task list they never saw.
//
// So the caller says where it came from and the page carries it through the
// form. Only a path on this prototype is accepted: anything with a scheme,
// a host, or a backslash is ignored and the old section-based answer is
// used instead.
function recordSafeReturn(value) {
  const v = String(value || '')
  if (!v || v.charAt(0) !== '/') return null
  if (v.charAt(1) === '/' || v.indexOf('\\') !== -1 || v.indexOf(':') !== -1) return null
  return v
}

function recordEditHome(req) {
  const asked = recordSafeReturn(
    (req.body && req.body.returnTo) || (req.query && req.query.return)
  )
  if (asked) return asked
  const section = req.session.data.recordTaskSection
  if (section === 'untested') return '/record-results-review/untested'
  if (section === 'reactions') return '/record-results-review/reactions'
  return req.session.data.recordTaskHome || '/record-results-tasks'
}

function recordEditView(req, row, values, errors) {
  const data = req.session.data
  return {
    row: row,
    values: values,
    errors: errors || null,
    errorList: errors ? Object.keys(errors).map(function (k) {
      return { text: errors[k], href: '#' + k }
    }) : [],
    reasons: recordReasons ? recordReasons() : [],
    back: recordEditHome(req),
    // Rendered as a hidden field so the POST returns to the same place the
    // GET would have, rather than falling back to the task list.
    returnTo: recordSafeReturn(
      (req.body && req.body.returnTo) || (req.query && req.query.return)
    ),
    total: (recordTaskState(req) || {}).total,
    reasonOther: (data.skinTestUntestedReasonOthers || {})[row.officialId] || ''
  }
}

router.get('/record-results-edit/:officialId', function (req, res) {
  if (recordSeedSession) { recordSeedSession(req, res) }
  const row = recordEditRow(req, req.params.officialId)
  if (!row) return res.redirect(recordEditHome(req))

  const m = row.measurements || {}

  // The screen opens showing what the vet just clicked Change on.
  //
  // Most of the herd has no explicit status: nothing was recorded against
  // them individually, and the list reads them as Clear. That is right on
  // the list, but it left this screen with no result selected at all - the
  // check page said Clear, the edit page said nothing, and the vet had to
  // re-answer a question they had already answered.
  //
  // Clear is pre-selected only where the clear-ness is recorded rather than
  // assumed: either the animal carries the status, or the rest of the herd
  // has been confirmed as tested with no reaction - which a handheld import
  // does on arrival, and the paper journey does on its own task.
  //
  // Where neither is true, nothing is pre-selected. An untouched row on a
  // part-typed paper list is not a clear animal, and the whole point of
  // taking the default off /v1-4/skin-test-reactors was to stop the service
  // answering for the vet.
  const restConfirmed = req.session.data.recordRestConfirmed === 'yes'
  const openingStatus = row.status ||
    ((restConfirmed && row.outcome === 'clear') ? 'clear' : '')

  res.render('record-results-edit', recordEditView(req, row, {
    status: openingStatus,
    reason: (req.session.data.skinTestUntestedReasons || {})[row.officialId] || '',
    reasonOther: (req.session.data.skinTestUntestedReasonOthers || {})[row.officialId] || '',
    avianBeforeInjection: m.avianBeforeInjection || '',
    avianAfter72Hours: m.avianAfter72Hours || '',
    bovineBeforeInjection: m.bovineBeforeInjection || '',
    bovineAfter72Hours: m.bovineAfter72Hours || '',
    avianOedema: m.avianOedema || 'C',
    bovineOedema: m.bovineOedema || 'C',
    reactorReference: row.reactorReference || ''
  }))
})

router.post('/record-results-edit/:officialId', function (req, res) {
  if (recordSeedSession) { recordSeedSession(req, res) }
  const row = recordEditRow(req, req.params.officialId)
  if (!row) return res.redirect(recordEditHome(req))

  const body = req.body || {}
  const values = {
    status: (body.status || '').trim(),
    reason: (body.reason || '').trim(),
    reasonOther: (body.reasonOther || '').trim(),
    avianBeforeInjection: (body.avianBeforeInjection || '').trim(),
    avianAfter72Hours: (body.avianAfter72Hours || '').trim(),
    bovineBeforeInjection: (body.bovineBeforeInjection || '').trim(),
    bovineAfter72Hours: (body.bovineAfter72Hours || '').trim(),
    avianOedema: body.avianOedema === 'SO' ? 'SO' : 'C',
    bovineOedema: body.bovineOedema === 'SO' ? 'SO' : 'C',
    reactorReference: (body.reactorReference || '').trim()
  }

  const errors = {}
  if (RECORD_EDIT_STATUSES.indexOf(values.status) === -1) {
    errors.status = 'Select a result for this animal'
  }

  if (values.status === 'not-tested') {
    if (!values.reason) errors.reason = 'Select why this animal was not tested'
    else if (values.reason === 'other' && !values.reasonOther) {
      errors.reasonOther = 'Enter the reason this animal was not tested'
    }
  }

  let interpretation = null
  if (values.status === 'reaction') {
    const mm = /^\d{1,2}(\.\d)?$/
    const fields = {
      avianBeforeInjection: 'the avian measurement before injection',
      avianAfter72Hours: 'the avian measurement after 72 hours',
      bovineBeforeInjection: 'the bovine measurement before injection',
      bovineAfter72Hours: 'the bovine measurement after 72 hours'
    }
    Object.keys(fields).forEach(function (f) {
      if (!values[f]) errors[f] = 'Enter ' + fields[f]
      else if (!mm.test(values[f])) errors[f] = 'Enter ' + fields[f] + ' in millimetres'
    })
    if (!Object.keys(errors).length) {
      interpretation = sicctInterpretation.interpretSicct({
        avianIncrease: parseFloat(values.avianAfter72Hours) - parseFloat(values.avianBeforeInjection),
        bovineIncrease: parseFloat(values.bovineAfter72Hours) - parseFloat(values.bovineBeforeInjection),
        avianOedema: values.avianOedema,
        bovineOedema: values.bovineOedema,
        interpretationType: 'standard'
      })
      // Only a reactor is tagged. An inconclusive animal stays on the farm
      // to be retested, so there is no number to write down.
      if (interpretation && interpretation.resultCode === 'REACTOR' && !values.reactorReference) {
        errors.reactorReference = 'Enter the reactor tag number'
      }
    }
  }

  if (Object.keys(errors).length) {
    return res.render('record-results-edit', recordEditView(req, row, values, errors))
  }

  recordSaveAnimal(req, row.officialId, {
    status: values.status,
    reason: values.reason,
    reasonOther: values.reasonOther,
    measurements: values.status === 'reaction' ? {
      avianBeforeInjection: values.avianBeforeInjection,
      avianAfter72Hours: values.avianAfter72Hours,
      bovineBeforeInjection: values.bovineBeforeInjection,
      bovineAfter72Hours: values.bovineAfter72Hours,
      avianOedema: values.avianOedema,
      bovineOedema: values.bovineOedema,
      reactorReference: values.reactorReference
    } : null
  })

  res.redirect(recordEditHome(req))
})

// Adding one animal to a section, the add-another way: name the animal,
// give the reason, come back to the list with it on. The review page is
// the "what you have added so far" half of the pattern; this is the
// "add one" half. The old link went to the 102-row picker, which is a
// different job - choosing a set, not adding a single animal.
router.get('/record-results-add/untested', function (req, res) {
  if (recordSeedSession) { recordSeedSession(req, res) }
  res.render('record-results-add-untested', recordAddView(req, { earTag: '', reason: '', reasonOther: '' }, null))
})

function recordAddView(req, values, errors) {
  const animals = getAnimalsForSelection('12/312/6802', 'v1-4') || []
  const accounted = new Set(
    (Array.isArray(req.session.data.skinTestUntested) ? req.session.data.skinTestUntested : [])
  )
  return {
    // Anything already on the not-tested list is not offered again - it is
    // already there to be changed on the list behind this page.
    suggestions: animals
      .filter(function (a) { return !accounted.has(a.officialId) })
      .map(function (a) { return { officialId: a.officialId } }),
    reasons: recordReasons ? recordReasons() : [],
    values: values,
    errors: errors || null,
    errorList: errors ? Object.keys(errors).map(function (k) {
      return { text: errors[k], href: '#' + (k === 'earTag' ? 'earTag' : k) }
    }) : [],
    back: '/record-results-review/untested'
  }
}

router.post('/record-results-add/untested', function (req, res) {
  if (recordSeedSession) { recordSeedSession(req, res) }
  const body = req.body || {}
  const values = {
    earTag: (body.earTag || '').trim(),
    reason: (body.reason || '').trim(),
    reasonOther: (body.reasonOther || '').trim()
  }

  const animals = getAnimalsForSelection('12/312/6802', 'v1-4') || []
  const known = new Set(animals.map(function (a) { return a.officialId }))

  const errors = {}
  if (!values.earTag) errors.earTag = 'Select the animal that could not be tested'
  else if (!known.has(values.earTag)) errors.earTag = 'Enter an ear tag from this cattle list'
  if (!values.reason) errors.reason = 'Select why this animal was not tested'
  else if (values.reason === 'other' && !values.reasonOther) {
    errors.reasonOther = 'Enter the reason this animal was not tested'
  }

  if (Object.keys(errors).length) {
    return res.render('record-results-add-untested', recordAddView(req, values, errors))
  }

  recordSaveAnimal(req, values.earTag, {
    status: 'not-tested',
    reason: values.reason,
    reasonOther: values.reasonOther
  })

  res.redirect('/record-results-review/untested')
})

router.get('/record-results-review/:section', function (req, res) {
  const key = req.params.section
  const review = RECORD_REVIEWS[key]
  const home = req.session.data.recordTaskHome || '/record-results-tasks'
  if (!review) return res.redirect(home)

  if (recordSeedSession) { recordSeedSession(req, res) }
  req.session.data.recordTaskMode = 'yes'
  req.session.data.recordTaskSection = key

  const all = recordCheckList ? recordCheckList(req) : []
  const rows = all.filter(function (r) { return r.status === review.status })

  res.render('record-results-review', {
    mode: key,
    review: review,
    rows: rows,
    home: home,
    total: (recordTaskState(req) || {}).total
  })
})

router.get('/record-results-confirm-rest', function (req, res) {
  res.render('record-results-confirm-rest', { task: recordTaskState(req) })
})

router.post('/record-results-confirm-rest', function (req, res) {
  req.session.data.recordRestConfirmed = 'yes'
  return res.redirect('/record-results-tasks')
})

registerSkinTestRoutes('v1-1')
registerSkinTestRoutes('v1-2')
registerSkinTestRoutes('v1-3')
registerSkinTestRoutes('v1-4')
registerSkinTestRoutes('v1-5')

module.exports = router
