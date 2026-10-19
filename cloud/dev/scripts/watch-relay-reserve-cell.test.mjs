import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  evaluateWatchSample,
  initialWatchState,
  measuredBackground,
  measuredPhoneBackground,
  phoneMinuteOver,
  phoneShareLine,
  PHONE_RULE_NAMES,
  PHONE_WATCH_RULES
} from './relay-reserve-watch-rules.mjs'
import {
  ALARM_EVENT,
  ALARM_LOG_NAME,
  FLIP_BACK_ATTEMPTS,
  FLIP_BACK_RUNTIME_ATTEMPTS,
  flipBack,
  parseWatchArguments,
  parseWatchSegment,
  raiseAlarm,
  readCellPhoneMinutes,
  readDirector503Minutes,
  readSeatBehindRowSample,
  recordOutcome,
  rolloutLeaseRefusal,
  watchSegment
} from './watch-relay-reserve-cell.mjs'
import { readRelayWorkflow } from './relay-repository.mjs'

const CELL = 'production-gce-c26'
const START = Date.parse('2026-10-14T12:00:00Z')
const MINUTE = 60_000
const LIMIT = { unverifiableLimit: 3 }

const healthyCell = (overrides = {}) => ({
  ok: true,
  admitModeConfigured: 'reserve',
  admitModeEffective: 'reserve',
  draining: false,
  controls: 1_000,
  enforcedUnits: 1_100,
  hardCap: 2_000,
  ...overrides
})
const minutesBefore = (at, count) =>
  Array.from({ length: count }, (_, index) =>
    new Date(Math.floor(at / MINUTE) * MINUTE - (count + 3 - index) * MINUTE).toISOString().slice(0, 16)
  )
const quiet503 = (at, perMinute = 10) => {
  const minutes = minutesBefore(at, 3)
  return { ok: true, minutes, perMinute: Object.fromEntries(minutes.map((minute) => [minute, perMinute])), publishedThrough: minutes.at(-1), unmetered: [] }
}
const sampleAt = (at, overrides = {}) => ({
  at,
  cell: healthyCell(),
  director503: quiet503(at),
  ledger: { ok: true, unwrittenRows: 0, directors: 5 },
  seatBehindRow: { ok: true, reports: [] },
  ...overrides
})
const freshState = (overrides = {}) => ({
  ...initialWatchState({ cellId: CELL, startedAt: START, durationMinutes: 60, background503PerMinute: 10 }),
  ...overrides
})

// Runs samples one minute apart; returns every result.
function run(samples, state = freshState()) {
  const results = []
  for (const sample of samples) {
    const result = evaluateWatchSample(state, sample, LIMIT)
    results.push(result)
    state = result.state
    if (state.state !== 'watching') break
  }
  return results
}

test('a healthy cell keeps watching and completes at the deadline', () => {
  const results = run(Array.from({ length: 61 }, (_, minute) => sampleAt(START + minute * MINUTE)))
  assert.equal(results.length, 61)
  assert.ok(results.slice(0, 60).every((result) => result.state.state === 'watching'))
  assert.equal(results.at(-1).state.state, 'completed')
  const line = JSON.parse(results[0].line)
  assert.equal(line.event, 'orca_relay_reserve_watch_sample')
  assert.deepEqual(Object.keys(line.rules), ['deadMan', 'overrun', 'director503', 'duplicateSeat', 'hostDrop', 'ledgerDrift'])
})

test('503s trip only after three complete minutes over max(1.5x background, background + 20)', () => {
  // Background 100: the line is 150. Two minutes over and one under is not a trip.
  const state = freshState({ background: { medianPerMinute: 100, source: 'input' } })
  const series = (counts) => {
    const minutes = minutesBefore(START, 3)
    return {
      ok: true,
      minutes,
      perMinute: Object.fromEntries(minutes.map((minute, index) => [minute, counts[index]])),
      publishedThrough: minutes.at(-1),
      unmetered: []
    }
  }
  const twoOver = evaluateWatchSample(state, sampleAt(START, { director503: series([151, 140, 200]) }), LIMIT)
  assert.equal(twoOver.state.state, 'watching')
  const atLine = evaluateWatchSample(state, sampleAt(START, { director503: series([150, 150, 150]) }), LIMIT)
  assert.equal(atLine.state.state, 'watching')
  const threeOver = evaluateWatchSample(state, sampleAt(START, { director503: series([151, 160, 170]) }), LIMIT)
  assert.equal(threeOver.state.state, 'tripped')
  assert.match(threeOver.state.verdict, /^flip back production-gce-c26: director503: /)
  // A zero background still needs 20 a minute, not one 503.
  const zero = freshState({ background: { medianPerMinute: 0, source: 'input' } })
  assert.equal(evaluateWatchSample(zero, sampleAt(START, { director503: series([5, 5, 5]) }), LIMIT).state.state, 'watching')
  assert.equal(evaluateWatchSample(zero, sampleAt(START, { director503: series([21, 21, 21]) }), LIMIT).state.state, 'tripped')
  // A published minute with no 503 point had none.
  const gap = series([151, 160, 170])
  delete gap.perMinute[gap.minutes[1]]
  assert.equal(evaluateWatchSample(state, sampleAt(START, { director503: gap }), LIMIT).state.state, 'watching')
})

test('a quiet fleet with no 503 series at all reads zero, not unverifiable', () => {
  const minutes = minutesBefore(START, 10)
  const quiet = { ok: true, minutes, perMinute: {}, publishedThrough: minutes.at(-1), unmetered: [] }
  const [result] = run([sampleAt(START, { director503: quiet })], freshState({ background: { medianPerMinute: 0, source: 'measured' } }))
  assert.equal(result.rules.director503.status, 'pass')
  assert.deepEqual(Object.values(result.rules.director503.recent), [0, 0, 0])
  assert.equal(result.state.unverifiableStreak, 0)
  assert.deepEqual(measuredBackground({ perMinute: {}, minutes, publishedThrough: minutes.at(-1), unmetered: [] }), { medianPerMinute: 0, minutes: 10, source: 'measured' })
})

test('503 minutes past the publishing front are left out, and only no front at all is unverifiable', () => {
  const state = freshState({ background: { medianPerMinute: 100, source: 'input' } })
  const minutes = minutesBefore(START, 10)
  const judge = (director503) => evaluateWatchSample(state, sampleAt(START, { director503 }), LIMIT)
  // The front is two minutes behind: the three minutes before it are judged, the two after are not.
  const over = Object.fromEntries(minutes.map((minute) => [minute, 500]))
  const behind = judge({ ok: true, minutes, perMinute: over, publishedThrough: minutes[7], unmetered: [] })
  assert.equal(behind.rules.director503.status, 'trip')
  assert.deepEqual(Object.keys(behind.rules.director503.recent), minutes.slice(5, 8))
  // A sparse 503 series: minutes after its last point but within the front are zero, not late.
  const sparse = judge({ ok: true, minutes, perMinute: { [minutes[2]]: 500 }, publishedThrough: minutes.at(-1), unmetered: [] })
  assert.equal(sparse.rules.director503.status, 'pass')
  assert.equal(sparse.state.unverifiableStreak, 0)
  // No request series at all.
  const empty = judge({ ok: true, minutes, perMinute: {}, publishedThrough: null, unmetered: [] })
  assert.equal(empty.rules.director503.status, 'unverifiable')
  assert.match(empty.rules.director503.reason, /request series is empty/)
  assert.equal(empty.state.unverifiableStreak, 1)
  // A front too far behind to leave three published minutes in the read.
  const stale = judge({ ok: true, minutes, perMinute: {}, publishedThrough: minutes[1], unmetered: [] })
  assert.equal(stale.rules.director503.status, 'unverifiable')
  assert.match(stale.rules.director503.reason, new RegExp(`published only through ${minutes[1]}`))
})

const SEAT_EVENT = 'orca_relay_reserve_ledger_seat_behind_row'
const SUMMARY_EVENT = 'orca_relay_reserve_ledger_summary'
const summaryLine = (at, instanceId = 'a') => ({
  timestamp: new Date(at).toISOString(),
  labels: { instanceId },
  jsonPayload: { event: SUMMARY_EVENT, pending: 0, dropped: 0 }
})

// A Cloud Monitoring or Cloud Logging reader over fakes, as the watch builds one.
const fakeReader = ({ fetch: fetchImpl = async () => new Response('{}'), runGcloud = async () => ({ stdout: 'token' }) } = {}) => ({
  fetch: fetchImpl,
  runGcloud,
  retryDelayMs: 0,
  readTimeoutMs: 1_000,
  now: () => START,
  deadlineAt: START + 10_000,
  projectId: 'onorca-cloud'
})

test('an unparseable timestamp makes the read unverifiable', async () => {
  const badPoint = {
    timeSeries: [{ points: [{ interval: { endTime: 'not a time' }, value: { int64Value: '3' } }] }]
  }
  const read503 = await readDirector503Minutes(
    fakeReader({ fetch: async () => new Response(JSON.stringify(badPoint)) }),
    { projectId: 'onorca-cloud', directorService: 'orca-cloud-relay', endedAt: START, minutes: 3 }
  )
  assert.equal(read503.ok, false)
  assert.match(read503.error, /unreadable/)
  const seats = await readSeatBehindRowSample(
    fakeReader({ runGcloud: async () => ({ stdout: JSON.stringify([summaryLine(START), { timestamp: 'garbage', jsonPayload: { epoch: 1, rowEpoch: 2 } }]) }) }),
    { directorService: 'orca-cloud-relay', cellId: CELL, at: START }
  )
  assert.equal(seats.ok, false)
  assert.match(seats.error, /unparseable timestamp/)
})

test('a seat-behind-row key carries the director instance and cell beside the epochs', async () => {
  const entry = (instanceId) => ({ timestamp: new Date(START).toISOString(), labels: { instanceId }, jsonPayload: { event: SEAT_EVENT, epoch: 7, rowEpoch: 8 } })
  const read = await readSeatBehindRowSample(
    fakeReader({ runGcloud: async () => ({ stdout: JSON.stringify([entry('a'), summaryLine(START), entry('b')]) }) }),
    { directorService: 'orca-cloud-relay', cellId: CELL, at: START }
  )
  assert.deepEqual(read.reports.map((report) => report.key), [`a/${CELL}/7:8`, `b/${CELL}/7:8`])
})

test('the duplicate read carries a positive control: no fresh ledger summary in it is unverifiable, not zero', async () => {
  const filters = []
  const readWith = (entries) =>
    readSeatBehindRowSample(
      fakeReader({ runGcloud: async (args) => (filters.push(args[2]), { stdout: JSON.stringify(entries) }) }),
      { directorService: 'orca-cloud-relay', cellId: CELL, at: START }
    )
  // One read, one window: the control rides the same filter as the seat lines.
  assert.deepEqual(await readWith([summaryLine(START - 30_000)]), { ok: true, reports: [] })
  assert.match(filters[0], new RegExp(`\\(\\(jsonPayload\\.event="${SEAT_EVENT}" AND jsonPayload\\.cellId="${CELL}"\\) OR jsonPayload\\.event="${SUMMARY_EVENT}"\\)`))
  assert.match(filters[0], /resource\.labels\.service_name="orca-cloud-relay"/)
  for (const entries of [[], [summaryLine(START - 10 * MINUTE)]]) {
    const blind = await readWith(entries)
    assert.equal(blind.ok, false)
    assert.match(blind.error, /no fresh ledger summary \(positive control\)/)
  }
  // Blind is a gap in the sample, which counts toward the unverifiable streak.
  const [gap] = run([sampleAt(START, { seatBehindRow: await readWith([]) })])
  assert.equal(gap.rules.duplicateSeat.status, 'unverifiable')
  assert.equal(gap.state.unverifiableStreak, 1)
})

test('the measured background is the median of the metered minutes before the flip, published gaps as zero', () => {
  const minutes = ['2026-10-14T11:47', '2026-10-14T11:48', '2026-10-14T11:49']
  const front = minutes[2]
  const background = (perMinute, publishedThrough, readMinutes = minutes, unmetered = []) =>
    measuredBackground({ perMinute, minutes: readMinutes, publishedThrough, unmetered })
  assert.equal(background({ '2026-10-14T11:48': 30 }, front).medianPerMinute, 0)
  assert.equal(background({ [minutes[0]]: 10, [minutes[1]]: 30, [minutes[2]]: 20 }, front).medianPerMinute, 20)
  assert.equal(background({}, '2026-10-14T11:52').medianPerMinute, 0)
  // Not published through the last minute yet, or no request series: no background yet.
  assert.equal(background({ [minutes[0]]: 10 }, minutes[1]), null)
  assert.equal(background({}, null), null)
  assert.equal(background({}, front, []), null)
  // An unmetered minute is left out, not read as zero; under half metered is no background.
  assert.deepEqual(background({ [minutes[0]]: 10, [minutes[1]]: 30, [minutes[2]]: 20 }, front, minutes, [minutes[0]]), { medianPerMinute: 25, minutes: 2, source: 'measured' })
  assert.equal(background({}, front, minutes, minutes.slice(1)), null)
})

test('any overrun trips at once', () => {
  const [result] = run([sampleAt(START, { cell: healthyCell({ enforcedUnits: 2_001 }) })])
  assert.equal(result.state.state, 'tripped')
  assert.match(result.state.verdict, /overrun: ledger units 2001 over hard cap 2000/)
  const [atCap] = run([sampleAt(START, { cell: healthyCell({ enforcedUnits: 2_000 }) })])
  assert.equal(atCap.state.state, 'watching')
})

test('a seat reported behind its row again past the grace trips; inside the grace it does not', () => {
  const report = (at) => ({ at, key: '7:8' })
  const within = run([
    sampleAt(START, { seatBehindRow: { ok: true, reports: [report(START - 30_000)] } }),
    sampleAt(START + MINUTE, { seatBehindRow: { ok: true, reports: [report(START - 30_000), report(START + 50_000)] } })
  ])
  assert.equal(within.at(-1).state.state, 'watching')
  // Carried across samples: the second read no longer holds the first report.
  const past = run([
    sampleAt(START, { seatBehindRow: { ok: true, reports: [report(START - 30_000)] } }),
    sampleAt(START + 2 * MINUTE, { seatBehindRow: { ok: true, reports: [report(START + 70_000)] } })
  ])
  assert.equal(past.at(-1).state.state, 'tripped')
  assert.match(past.at(-1).state.verdict, /duplicateSeat: a seat behind its ledger row \(7:8\)/)
  // Another seat's report is not the same seat.
  const other = run([
    sampleAt(START, { seatBehindRow: { ok: true, reports: [report(START - 30_000)] } }),
    sampleAt(START + 2 * MINUTE, { seatBehindRow: { ok: true, reports: [{ at: START + 70_000, key: '3:4' }] } })
  ])
  assert.equal(other.at(-1).state.state, 'watching')
})

test('a host drop over 5% in 5 minutes trips outside a drain only', () => {
  const controls = [1_000, 990, 980, 960, 949]
  const samples = (draining) =>
    controls.map((count, minute) =>
      sampleAt(START + minute * MINUTE, { cell: healthyCell({ controls: count, draining: draining && minute === 2 }) })
    )
  assert.equal(run(samples(false)).at(-1).state.state, 'tripped')
  assert.match(run(samples(false)).at(-1).state.verdict, /hostDrop: connected hosts fell 1000 -> 949/)
  assert.equal(run(samples(true)).at(-1).state.state, 'watching')
  // A drop spread over more than 5 minutes is not one.
  const slow = [1_000, 990, 980, 970, 960, 955, 950].map((count, minute) =>
    sampleAt(START + minute * MINUTE, { cell: healthyCell({ controls: count }) })
  )
  assert.equal(run(slow).at(-1).state.state, 'watching')
  // Under the floor on a nearly empty cell: 100 -> 92 is 8%, but only 8 hosts.
  const small = [100, 92].map((count, minute) => sampleAt(START + minute * MINUTE, { cell: healthyCell({ controls: count }) }))
  assert.equal(run(small).at(-1).state.state, 'watching')
})

test('ledger drift over 0.5% trips once it has lasted 2 minutes', () => {
  const drift = (rows) => ({ ok: true, unwrittenRows: rows, directors: 5 })
  const brief = run([6, 6, 0, 6].map((rows, minute) => sampleAt(START + minute * MINUTE, { ledger: drift(rows) })))
  assert.equal(brief.at(-1).state.state, 'watching')
  const sustained = run([6, 6, 6].map((rows, minute) => sampleAt(START + minute * MINUTE, { ledger: drift(rows) })))
  assert.equal(sustained.length, 3)
  assert.equal(sustained.at(-1).state.state, 'tripped')
  assert.match(sustained.at(-1).state.verdict, /ledgerDrift: ledger drift 0\.60% for 120 s/)
  const atLine = run([5, 5, 5, 5].map((rows, minute) => sampleAt(START + minute * MINUTE, { ledger: drift(rows) })))
  assert.equal(atLine.at(-1).state.state, 'watching')
})

test('a tripped dead-man is a trip: Postgres still records reserve until a db write', () => {
  const [result] = run([sampleAt(START, { cell: healthyCell({ admitModeEffective: 'db' }) })])
  assert.equal(result.state.state, 'tripped')
  assert.match(result.state.verdict, /deadMan: the cell tripped its dead-man/)
})

test('unreadable data is never healthy: N samples in a row with any gap trip', () => {
  const unreadable = { ok: false, error: 'cell runtime status returned 502' }
  const gaps = [
    { cell: unreadable },
    { ledger: { ok: false, error: 'no placing director logged a ledger summary' } },
    { director503: { ok: false, error: 'director 503 metric read failed', perMinute: {}, minutes: [], publishedThrough: null } }
  ]
  const results = run(gaps.map((gap, minute) => sampleAt(START + minute * MINUTE, gap)))
  assert.deepEqual(results.map((result) => result.state.unverifiableStreak), [1, 2, 3])
  assert.equal(results.at(-1).state.state, 'tripped')
  assert.match(results.at(-1).state.verdict, /unverifiable: 3 samples in a row could not read director503/)
  // One whole sample resets the streak.
  const reset = run(
    [gaps[0], {}, gaps[0], gaps[0]].map((gap, minute) => sampleAt(START + minute * MINUTE, gap))
  )
  assert.deepEqual(reset.map((result) => result.state.unverifiableStreak), [1, 0, 1, 2])
  assert.equal(reset.at(-1).state.state, 'watching')
  // No background yet is a gap too.
  const noBackground = freshState({ background: null })
  assert.equal(evaluateWatchSample(noBackground, sampleAt(START), LIMIT).state.unverifiableStreak, 1)
  // A measured trip still wins over a gap elsewhere.
  const [both] = run([sampleAt(START, { cell: healthyCell({ enforcedUnits: 2_500 }), ledger: gaps[1].ledger })])
  assert.equal(both.state.state, 'tripped')
  assert.match(both.state.verdict, /overrun/)
})

test('a cell no longer in reserve stops the watch without a write; one never in reserve is refused', () => {
  const dbCell = healthyCell({ admitModeConfigured: 'db', admitModeEffective: 'reserve' })
  const later = run([sampleAt(START), sampleAt(START + MINUTE, { cell: dbCell })])
  assert.equal(later.at(-1).state.state, 'stopped')
  assert.match(later.at(-1).state.verdict, /is not in reserve mode \(switch file says db\)/)
  // Never reserve within the wait: refused, which the workflow does not flip back.
  const never = run(Array.from({ length: 12 }, (_, minute) => sampleAt(START + minute * MINUTE, { cell: dbCell })))
  assert.equal(never.at(-1).state.state, 'refused')
  assert.equal(never.length, 11)
  assert.match(never.at(-1).state.verdict, /did not report reserve mode within 10 min \(switch file says db\)/)
})

test('a watch dispatched before the reserve write applied waits for it, then judges as usual', () => {
  const dbCell = healthyCell({ admitModeConfigured: 'db', admitModeEffective: 'db' })
  const results = run([
    sampleAt(START, { cell: dbCell, ledger: { ok: false, error: 'not yet' } }),
    sampleAt(START + MINUTE, { cell: dbCell }),
    sampleAt(START + 2 * MINUTE),
    sampleAt(START + 3 * MINUTE, { cell: healthyCell({ enforcedUnits: 2_500 }) })
  ])
  // Waiting samples judge nothing: not a dead-man trip on a db cell, not a gap.
  assert.deepEqual(results.slice(0, 2).map((result) => result.state.state), ['watching', 'watching'])
  assert.equal(results[0].rules.reserve.status, 'pending')
  assert.deepEqual(Object.keys(results[0].rules), ['reserve'])
  assert.deepEqual(results.map((result) => result.state.unverifiableStreak), [0, 0, 0, 0])
  assert.equal(results[2].state.reserveSeenAt, START + 2 * MINUTE)
  assert.equal(results[2].rules.overrun.status, 'pass')
  assert.equal(results[3].state.state, 'tripped')
  // Once seen in reserve, a later db reads as a hand flip back, not a refusal.
  const after = run([sampleAt(START + 2 * MINUTE), sampleAt(START + 3 * MINUTE, { cell: dbCell })], results[0].state)
  assert.equal(after.at(-1).state.state, 'stopped')
})

const watchValues = (overrides = {}) => ({
  mode: 'dry-run',
  'cell-id': CELL,
  'cell-origin': 'https://c26.relay.onorca.dev',
  'project-id': 'onorca-cloud',
  'director-origin': 'https://relay.onorca.dev',
  'director-service': 'orca-cloud-relay',
  'duration-minutes': '120',
  'segment-minutes': '55',
  'unverifiable-limit': '3',
  'background-503-per-minute': '',
  'flipped-at': new Date(START - 5 * MINUTE).toISOString(),
  'state-file': '/unused',
  ...overrides
})
const parseAt = (values) => parseWatchArguments(values, START)

test('watch arguments reuse the flag tool checks, so a write watch needs its confirmation up front', () => {
  assert.equal(parseAt(watchValues()).background503PerMinute, null)
  assert.equal(parseAt(watchValues()).flippedAt, START - 5 * MINUTE)
  assert.equal(parseAt(watchValues({ 'background-503-per-minute': '12.5', 'flipped-at': '' })).background503PerMinute, 12.5)
  assert.throws(() => parseAt(watchValues({ mode: 'write' })), /WRITE_RELAY_CELL_FLAGS production-gce-c26/)
  assert.doesNotThrow(() => parseAt(watchValues({ mode: 'write', confirmation: `WRITE_RELAY_CELL_FLAGS ${CELL}` })))
  assert.throws(() => parseAt(watchValues({ 'cell-origin': 'https://c27.relay.onorca.dev' })), /names another cell/)
  assert.throws(() => parseAt(watchValues({ 'duration-minutes': '301' })), /duration-minutes/)
  assert.throws(() => parseAt(watchValues({ 'segment-minutes': '56' })), /segment-minutes/)
  assert.throws(() => parseAt(watchValues({ 'background-503-per-minute': '-1' })), /background/)
})

test('the 503 background needs flipped-at or an explicit value; flipped-at must be a recent zoned time', () => {
  assert.throws(() => parseAt(watchValues({ 'flipped-at': '' })), /--flipped-at .* or --background-503-per-minute is required/)
  assert.throws(() => parseAt(watchValues({ 'flipped-at': '2026-10-14T11:55:00' })), /ISO time with a zone/)
  assert.throws(() => parseAt(watchValues({ 'flipped-at': '2026-10-14T12:01:00Z' })), /in the future/)
  assert.throws(() => parseAt(watchValues({ 'flipped-at': '2026-10-13T11:00:00Z' })), /more than 24 hours/)
  assert.equal(parseAt(watchValues({ 'flipped-at': '2026-10-14T07:55:00-04:00' })).flippedAt, START - 5 * MINUTE)
})

// A cell, Cloud Monitoring and Cloud Logging, answering from `script` per sample.
const METRICS_EVENT = 'orca_relay_runtime_metrics'
// Each instance's line every 30 s inside the read's timestamp bounds, newest first.
function metricsLines(filter, metrics) {
  const [, from, to] = filter.match(/timestamp>="([^"]+)" AND timestamp<"([^"]+)"/)
  const lines = []
  for (let at = Math.ceil(Date.parse(from) / 30_000) * 30_000; at < Date.parse(to); at += 30_000) {
    for (const deltas of metrics(at)) lines.push({ timestamp: new Date(at).toISOString(), jsonPayload: deltas })
  }
  return lines.reverse()
}

function fakeSources({
  cell = () => ({}),
  // Logged at each sample's minute, so it stays fresh for the positive control.
  ledger = (sample) => [{ timestamp: new Date(START + (sample - 1) * MINUTE).toISOString(), labels: { instanceId: 'a' }, jsonPayload: { pending: 0, dropped: 0 } }],
  per503 = () => 10,
  // Requests of every other code per minute; zero is a minute with no traffic at all.
  perOther = () => 1_000,
  seatControl = true,
  rolloutLease = null,
  // Each director instance's runtime-metrics deltas for the 30 s ending at `endedAt`.
  metrics = () => [{}]
} = {}) {
  let samples = 0
  const monitoringSpans = []
  const fetchImpl = async (url) => {
    const text = String(url)
    if (text.endsWith('/v1/admin/runtime-status')) {
      samples += 1
      const overrides = cell(samples)
      return new Response(
        JSON.stringify({
          role: 'cell',
          cellId: CELL,
          draining: false,
          flagsApplied: { generation: 4, flags: { admitMode: 'reserve', readinessLocal: true } },
          admitModeEffective: 'reserve',
          connectionCapacity: { hardCap: 2_000 },
          runtime: { controls: 1_000, enforcedConnectionUnits: 1_100 },
          ...overrides
        })
      )
    }
    if (text.startsWith('https://monitoring.googleapis.com/')) {
      const params = new URL(text).searchParams
      const span = { startedAt: Date.parse(params.get('interval.startTime')), endedAt: Date.parse(params.get('interval.endTime')) }
      monitoringSpans.push(span)
      assert.equal(params.get('aggregation.groupByFields'), 'metric.label."response_code"')
      assert.doesNotMatch(params.get('filter'), /response_code/)
      // Cloud Monitoring returns no point for a minute with no requests of that code.
      const seriesOf = (code, count) => {
        const points = []
        for (let minute = span.startedAt; minute < span.endedAt; minute += MINUTE) {
          if (count(minute) > 0) {
            points.push({ interval: { endTime: new Date(minute + MINUTE).toISOString() }, value: { int64Value: String(count(minute)) } })
          }
        }
        return points.length === 0 ? [] : [{ metric: { labels: { response_code: code } }, points }]
      }
      return new Response(JSON.stringify({ timeSeries: [...seriesOf('200', perOther), ...seriesOf('503', per503)] }))
    }
    throw new Error(`unexpected fetch ${text}`)
  }
  const runGcloud = async (args) => {
    if (args[0] === 'auth') return { stdout: 'token' }
    const filter = args[2]
    const summaries = ledger(samples).map((entry) => ({ ...entry, jsonPayload: { ...entry.jsonPayload, event: SUMMARY_EVENT } }))
    if (filter.includes(SEAT_EVENT)) return { stdout: JSON.stringify(seatControl ? summaries : []) }
    if (filter.includes(SUMMARY_EVENT)) return { stdout: JSON.stringify(ledger(samples)) }
    if (filter.includes(METRICS_EVENT)) return { stdout: JSON.stringify(metricsLines(filter, metrics)) }
    return { stdout: '[]' }
  }
  return { fetchImpl, runGcloud, monitoringSpans, readRolloutLease: async () => rolloutLease }
}

test('a segment samples once a minute, carries state to the next segment, and stops on a trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    let clock = START
    const lines = []
    const config = parseAt(
      watchValues({ 'state-file': join(directory, 'state.json'), 'github-output': join(directory, 'out'), 'segment-minutes': '3' })
    )
    const sources = fakeSources({ cell: (sample) => (sample === 5 ? { runtime: { controls: 1_000, enforcedConnectionUnits: 2_001 } } : {}) })
    const dependencies = {
      ...sources,
      idToken: 'id',
      retryDelayMs: 0,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      log: (line) => lines.push(JSON.parse(line))
    }
    const first = await watchSegment(config, dependencies)
    assert.equal(first.state, 'watching')
    assert.equal(lines.length, 3)
    assert.equal(first.background.source, 'measured')
    assert.equal(await readFile(join(directory, 'out'), 'utf8'), 'state=watching\nverdict=\nflip=admitMode\n')
    const second = await watchSegment(config, dependencies)
    assert.equal(second.state, 'tripped')
    assert.equal(second.samples, 5)
    assert.deepEqual(lines.map((line) => line.sample), [1, 2, 3, 4, 5])
    assert.equal(lines.at(-1).rules.overrun.status, 'trip')
    assert.match(await readFile(join(directory, 'out'), 'utf8'), /state=tripped\nverdict=flip back production-gce-c26: overrun: /)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a sample that cannot read its sources counts as unverifiable rather than crashing the watch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    let clock = START
    const config = parseAt(watchValues({ 'state-file': join(directory, 'state.json'), 'segment-minutes': '10' }))
    const sources = fakeSources({ ledger: () => [] })
    const state = await watchSegment(config, {
      ...sources,
      idToken: 'id',
      retryDelayMs: 0,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      log: () => {}
    })
    assert.equal(state.state, 'tripped')
    assert.equal(state.samples, 3)
    // No summary also blinds the duplicate rule, whose positive control it is.
    assert.match(state.verdict, /unverifiable: 3 samples in a row could not read duplicateSeat, ledgerDrift/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a watch that ended without a verdict records failed, which the workflow flips back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    const output = join(directory, 'out')
    assert.equal((await recordOutcome(join(directory, 'missing.json'), output)).state, 'failed')
    await writeFile(join(directory, 'watching.json'), JSON.stringify(freshState()))
    assert.equal((await recordOutcome(join(directory, 'watching.json'), output)).state, 'failed')
    await writeFile(join(directory, 'tripped.json'), JSON.stringify(freshState({ state: 'tripped', verdict: 'flip back x:\ny' })))
    assert.equal((await recordOutcome(join(directory, 'tripped.json'), output)).state, 'tripped')
    assert.match(await readFile(output, 'utf8'), /state=tripped\nverdict=flip back x: y\nflip=admitMode\n$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// Google Storage and the director, as far as the flag tool's flip back reaches them. `onUpload`
// returns 'conflict' to play another writer landing first, optionally with its own admitMode.
function fakeFlipBack({
  generation = '7',
  onUpload = () => 'ok',
  cellAnswers = true,
  flags = { admitMode: 'reserve', readinessLocal: true },
  supportedFlags = {
    admitMode: { type: 'enum', values: ['db', 'reserve'] },
    readinessLocal: { type: 'boolean' },
    phonePath: { type: 'enum', values: ['db', 'memory'] }
  }
} = {}) {
  const calls = []
  let uploads = 0
  let object = { generation: Number(generation), flags }
  let applied = object
  const fetchImpl = async (url, init = {}) => {
    const text = String(url)
    calls.push({ url: text, method: init.method ?? 'GET', body: init.body })
    if (text.includes('/upload/storage/v1/')) {
      uploads += 1
      assert.match(text, new RegExp(`ifGenerationMatch=${object.generation}$`))
      const outcome = onUpload(uploads)
      if (outcome !== 'ok') {
        object = { generation: object.generation + 1, flags: { ...object.flags, admitMode: outcome.admitMode ?? 'reserve' } }
        applied = object
        return new Response('', { status: 412 })
      }
      object = { generation: object.generation + 1, flags: JSON.parse(init.body.split('\r\n')[7]).flags }
      applied = object
      return new Response(JSON.stringify({ generation: String(object.generation) }))
    }
    if (text.includes('?alt=media')) {
      return new Response(JSON.stringify({ v: 1, cellId: CELL, flags: object.flags }))
    }
    if (text.includes('/storage/v1/b/')) return new Response(JSON.stringify({ generation: String(object.generation) }))
    if (text.endsWith('/v1/admin/runtime-status')) {
      if (!cellAnswers) return new Response('', { status: 502 })
      return new Response(
        JSON.stringify({
          role: 'cell',
          cellId: CELL,
          flagsApplied: applied,
          supportedFlags,
          admitModeEffective: applied.flags.admitMode,
          runtime: { controls: 10 }
        })
      )
    }
    if (text.endsWith('/v1/admin/cell-admit-mode')) {
      const admitMode = JSON.parse(init.body).admitMode
      return new Response(JSON.stringify({ v: 1, cellId: CELL, admitMode: admitMode ?? 'reserve', heartbeatFresh: true }))
    }
    throw new Error(`unexpected fetch ${text}`)
  }
  return { fetchImpl, calls, uploads: () => uploads }
}

const flipDependencies = (fetchImpl, lines, sleeps = []) => {
  let clock = START
  return {
    fetchImpl,
    accessToken: 'access',
    idToken: 'id',
    audit: { writtenBy: 'reserve-watch/test', runId: '1', runAttempt: '1' },
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms },
    log: (line) => lines.push(JSON.parse(line))
  }
}

const flipValues = (overrides = {}) => ({
  mode: 'write',
  'cell-id': CELL,
  'cell-origin': 'https://c26.relay.onorca.dev',
  'project-id': 'onorca-cloud',
  'director-origin': 'https://relay.onorca.dev',
  confirmation: `WRITE_RELAY_CELL_FLAGS ${CELL}`,
  ...overrides
})

test('the flip back is the flag tool write: admitMode=db at the generation just read, then Postgres db', async () => {
  const { fetchImpl, calls } = fakeFlipBack()
  const lines = []
  const result = await flipBack(flipValues(), flipDependencies(fetchImpl, lines))
  assert.equal(result.written, true)
  const upload = calls.find((call) => call.url.includes('/upload/storage/v1/'))
  assert.match(upload.body, /"flags":\{"admitMode":"db","readinessLocal":true\}/)
  assert.ok(calls.some((call) => call.url.endsWith('/v1/admin/cell-admit-mode') && JSON.parse(call.body).admitMode === 'db'))
  assert.deepEqual(lines.at(-1), {
    event: 'orca_relay_reserve_watch_flip_back',
    mode: 'write',
    cellId: CELL,
    written: true,
    generation: '8'
  })
})

test('a dry-run flip back plans the write and writes nothing', async () => {
  const { fetchImpl, calls } = fakeFlipBack()
  const lines = []
  const result = await flipBack(flipValues({ mode: 'dry-run', confirmation: '' }), {
    fetchImpl,
    accessToken: 'access',
    idToken: 'id',
    audit: {},
    sleep: async () => {},
    log: (line) => lines.push(JSON.parse(line))
  })
  assert.equal(result.written, false)
  assert.ok(!calls.some((call) => call.url.includes('/upload/')))
  assert.ok(!calls.some((call) => call.url.endsWith('/v1/admin/cell-admit-mode') && JSON.parse(call.body).admitMode))
  assert.equal(lines.find((line) => line.event === 'orca_relay_cell_flags_plan').desired.flags.admitMode, 'db')
})

test('a write flip back without the typed confirmation is refused before any read', async () => {
  const { fetchImpl, calls } = fakeFlipBack()
  await assert.rejects(
    flipBack(flipValues({ confirmation: '' }), { fetchImpl, accessToken: 'a', idToken: 'i', audit: {}, log: () => {} }),
    /WRITE_RELAY_CELL_FLAGS production-gce-c26/
  )
  assert.equal(calls.length, 0)
})

test('a generation conflict is re-read and retried while the switch file still says reserve', async () => {
  const { fetchImpl, uploads } = fakeFlipBack({ onUpload: (n) => (n < 3 ? { admitMode: 'reserve' } : 'ok') })
  const lines = []
  const sleeps = []
  const result = await flipBack(flipValues(), flipDependencies(fetchImpl, lines, sleeps))
  assert.equal(result.written, true)
  assert.equal(uploads(), 3)
  assert.deepEqual(lines.filter((line) => line.event === 'orca_relay_reserve_watch_flip_back_conflict').map((line) => line.attempt), [1, 2])
  assert.deepEqual(sleeps.slice(0, 1), [2_000])
  assert.equal(lines.at(-1).generation, '10')
})

test('a conflict whose writer already flipped the cell to db ends the flip back without a write', async () => {
  const { fetchImpl, uploads } = fakeFlipBack({ onUpload: () => ({ admitMode: 'db' }) })
  const lines = []
  const result = await flipBack(flipValues(), flipDependencies(fetchImpl, lines))
  assert.equal(uploads(), 1)
  assert.equal(result.written, false)
  assert.equal(result.alreadyDb, true)
  assert.deepEqual(lines.at(-1), { event: 'orca_relay_reserve_watch_flip_back', mode: 'write', cellId: CELL, written: false, generation: '8', alreadyDb: true })
})

test('conflicts past the retry bound fail the flip back', async () => {
  const { fetchImpl, uploads } = fakeFlipBack({ onUpload: () => ({ admitMode: 'reserve' }) })
  await assert.rejects(flipBack(flipValues(), flipDependencies(fetchImpl, [])), /object changed since expected-generation/)
  assert.equal(uploads(), FLIP_BACK_ATTEMPTS)
})

test('an unreachable cell fails with the exact break-glass inputs and writes nothing', async () => {
  const { fetchImpl, uploads } = fakeFlipBack({ cellAnswers: false })
  const lines = []
  await assert.rejects(
    flipBack(flipValues(), flipDependencies(fetchImpl, lines)),
    (error) => {
      assert.match(error.message, /production-gce-c26 does not answer runtime-status \(cell runtime status returned 502\)/)
      assert.match(error.message, /set=admitMode=default, break-glass=BREAK GLASS production-gce-c26, expected-generation=7/)
      return true
    }
  )
  assert.equal(uploads(), 0)
  assert.deepEqual(lines.at(-1).inputs, {
    mode: 'write',
    'cell-id': CELL,
    set: 'admitMode=default',
    'break-glass': `BREAK GLASS ${CELL}`,
    'expected-generation': '7',
    confirmation: `WRITE_RELAY_CELL_FLAGS ${CELL}`
  })
})

test('the 503 background is the 10 minutes before flipped-at, read once they are published', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    let clock = START
    // Flipped one minute ago: the minutes before it are not published until 3 minutes after it.
    const flippedAt = START - MINUTE + 20_000
    const config = parseAt(
      watchValues({ 'state-file': join(directory, 'state.json'), 'segment-minutes': '3', 'flipped-at': new Date(flippedAt).toISOString() })
    )
    const sources = fakeSources({ per503: (minute) => (minute < START - MINUTE ? 4 : 40) })
    const lines = []
    const state = await watchSegment(config, {
      ...sources,
      idToken: 'id',
      retryDelayMs: 0,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      log: (line) => lines.push(JSON.parse(line))
    })
    // Pending until then, and pending is not a gap: the streak stays at zero.
    assert.deepEqual(lines.map((line) => line.rules.director503.status), ['pending', 'pending', 'pass'])
    assert.match(lines[0].rules.director503.reason, /background before the flip is not published yet/)
    assert.deepEqual(lines.map((line) => line.unverifiableStreak), [0, 0, 0])
    const baseline = sources.monitoringSpans.find((span) => span.endedAt === START - MINUTE)
    assert.equal(baseline.startedAt, START - 11 * MINUTE)
    assert.deepEqual(state.background, { medianPerMinute: 4, minutes: 10, source: 'measured' })
    // An explicit value overrides the measurement.
    const explicit = initialWatchState({ cellId: CELL, startedAt: START, durationMinutes: 60, background503PerMinute: 9, flippedAt })
    assert.deepEqual(explicit.background, { medianPerMinute: 9, source: 'input' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a quiet fleet with zero director 503s watches on and never trips', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    let clock = START
    const config = parseAt(
      watchValues({
        'state-file': join(directory, 'state.json'),
        'segment-minutes': '20',
        'flipped-at': new Date(START - 2 * MINUTE).toISOString()
      })
    )
    const lines = []
    const state = await watchSegment(config, {
      ...fakeSources({ per503: () => 0 }),
      idToken: 'id',
      retryDelayMs: 0,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      log: (line) => lines.push(JSON.parse(line))
    })
    assert.equal(state.state, 'watching')
    assert.equal(lines.length, 20)
    assert.deepEqual(state.background, { medianPerMinute: 0, minutes: 10, source: 'measured' })
    assert.ok(lines.slice(1).every((line) => line.rules.director503.status === 'pass'))
    assert.ok(lines.every((line) => line.unverifiableStreak === 0))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// 2026-10-18's false trips: 503s tripled with traffic, nearly all a host re-dialling early.
const rateLimited = (perLine) => ({ placementRejectionsByReasonDelta: { 'host-rate-limited': perLine }, assign503sByCauseDelta: { 'placement-lane': perLine } })

async function watchFor(minutes, sources, flippedAt = START - 2 * MINUTE) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    let clock = START
    const config = parseAt(
      watchValues({ 'state-file': join(directory, 'state.json'), 'segment-minutes': String(minutes), 'flipped-at': new Date(flippedAt).toISOString() })
    )
    const lines = []
    const state = await watchSegment(config, {
      ...sources,
      idToken: 'id',
      retryDelayMs: 0,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      log: (line) => lines.push(JSON.parse(line))
    })
    return { state, lines }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('a host re-dialling inside its own interval never trips the 503 rule, however much it grows', async () => {
  // Background 20/min, all re-dials; then 50/min, 48 of them re-dials. All 503s would trip at 40.
  const flippedAt = START - 2 * MINUTE
  const { state, lines } = await watchFor(20, fakeSources({
    per503: (minute) => (minute < flippedAt ? 20 : 50),
    metrics: (at) => [rateLimited(at <= flippedAt ? 10 : 24)]
  }), flippedAt)
  assert.equal(state.state, 'watching')
  assert.deepEqual(state.background, { medianPerMinute: 0, minutes: 10, source: 'measured' })
  assert.ok(lines.slice(1).every((line) => line.rules.director503.status === 'pass'))
  assert.ok(lines.slice(1).every((line) => Object.values(line.rules.director503.recent).every((count) => count <= 2)))
})

test('503s the director could not serve trip after three minutes over the line, beside the re-dials', async () => {
  const flippedAt = START - 2 * MINUTE
  const { state } = await watchFor(10, fakeSources({
    per503: (minute) => (minute < flippedAt ? 20 : 60),
    // 10 re-dials a minute throughout; the 40 more after the flip are queue waits that timed out.
    metrics: (at) => [{
      ...rateLimited(5),
      stickyRejectionsByReasonDelta: at <= flippedAt ? {} : { 'wait-timeout': 20 }
    }]
  }), flippedAt)
  assert.equal(state.state, 'tripped')
  assert.deepEqual(state.background, { medianPerMinute: 10, minutes: 10, source: 'measured' })
  assert.match(state.verdict, /director503: director 503s above 30\/min for 3 min \(50, 50, 50\)/)
})

test('a minute no director instance logged runtime metrics for is unverifiable, not zero', async () => {
  // Two instances, both silent for three minutes in the middle of the read.
  const endedAt = START + 2 * MINUTE
  const silent = (at) => at > endedAt - 5 * MINUTE && at <= endedAt - 2 * MINUTE
  const reader = fakeSources({ per503: () => 50, metrics: (at) => (silent(at) ? [] : [rateLimited(12), rateLimited(12)]) })
  const read = await readDirector503Minutes(
    { ...fakeReader(), fetch: reader.fetchImpl, runGcloud: reader.runGcloud },
    { projectId: 'onorca-cloud', directorService: 'orca-cloud-relay', endedAt, minutes: 10 }
  )
  assert.equal(read.ok, true)
  assert.deepEqual(read.unmetered, read.minutes.slice(5, 8))
  assert.equal(read.perMinute[read.minutes[0]], 2)
  const judged = evaluateWatchSample(freshState({ background: { medianPerMinute: 0, source: 'measured' } }), sampleAt(START, { director503: read }), LIMIT)
  assert.equal(judged.rules.director503.status, 'unverifiable')
  assert.match(judged.rules.director503.reason, /no director runtime metrics for/)
  // No line at all in the read is short, not a quiet fleet.
  const unlogged = fakeSources({ per503: () => 50, metrics: () => [] })
  const none = await readDirector503Minutes(
    { ...fakeReader(), fetch: unlogged.fetchImpl, runGcloud: unlogged.runGcloud },
    { projectId: 'onorca-cloud', directorService: 'orca-cloud-relay', endedAt, minutes: 10 }
  )
  assert.equal(none.ok, false)
  assert.match(none.error, /runtime metrics read failed, truncated, or short/)
})

test('no request series at all is unverifiable and trips at the limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    let clock = START
    const config = parseAt(watchValues({ 'state-file': join(directory, 'state.json'), 'segment-minutes': '10', 'background-503-per-minute': '0', 'flipped-at': '' }))
    const state = await watchSegment(config, {
      ...fakeSources({ per503: () => 0, perOther: () => 0 }),
      idToken: 'id',
      retryDelayMs: 0,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      log: () => {}
    })
    assert.equal(state.state, 'tripped')
    assert.match(state.verdict, /unverifiable: 3 samples in a row could not read director503/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a later segment judges flipped-at against the watch start, so a long watch does not age it out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    const stateFile = join(directory, 'state.json')
    const values = watchValues({ 'state-file': stateFile, 'flipped-at': new Date(START - 23 * 60 * MINUTE).toISOString() })
    const later = START + 4 * 60 * MINUTE
    await writeFile(stateFile, JSON.stringify(freshState()))
    assert.equal((await parseWatchSegment(values, later)).flippedAt, START - 23 * 60 * MINUTE)
    // The first segment (no state file yet) still refuses it, and records refused.
    await rm(stateFile)
    await assert.rejects(parseWatchSegment(values, later), /more than 24 hours/)
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).state, 'refused')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a corrupt state file fails the segment, never refuses or restarts it, and the outcome reads failed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    const stateFile = join(directory, 'state.json')
    const output = join(directory, 'out')
    const values = watchValues({ 'state-file': stateFile })
    for (const corrupt of ['null', '[]', '7', JSON.stringify({ state: 'watching', cellId: 'c7' })]) {
      await writeFile(stateFile, corrupt)
      await assert.rejects(parseWatchSegment(values, START), /state file/)
      assert.equal(await readFile(stateFile, 'utf8'), corrupt)
      assert.equal((await recordOutcome(stateFile, output)).state, 'failed')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a slow runtime-status reply is retried before the flip back calls for break glass', async () => {
  const { fetchImpl: answering, uploads } = fakeFlipBack()
  let runtimeCalls = 0
  // fetchAdminOnceMore makes two tries per read; the first read's two both fail.
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/v1/admin/runtime-status') && (runtimeCalls += 1) <= 2) return new Response('', { status: 503 })
    return answering(url, init)
  }
  const lines = []
  const sleeps = []
  const result = await flipBack(flipValues(), flipDependencies(fetchImpl, lines, sleeps))
  assert.equal(result.written, true)
  assert.equal(uploads(), 1)
  assert.deepEqual(lines.filter((line) => line.event === 'orca_relay_reserve_watch_runtime_retry').map((line) => line.attempt), [1])
  assert.ok(!lines.some((line) => line.event === 'orca_relay_reserve_watch_break_glass_required'))
  assert.ok(sleeps.includes(2_000))
  assert.ok(FLIP_BACK_RUNTIME_ATTEMPTS > 1)
})

const watchWorkflow = readRelayWorkflow('operate-relay-production-reserve-watch.yml')
const jobOf = (name) => {
  const start = watchWorkflow.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `job ${name} is missing`)
  const next = watchWorkflow.slice(start + 1).search(/\n  [a-z-]+:\n/)
  return watchWorkflow.slice(start, next === -1 ? undefined : start + 1 + next)
}

test('workflow: neither job takes the flag workflow group, which would let a newer run cancel a pending flip back', () => {
  assert.doesNotMatch(watchWorkflow, /group: relay-production-cell-flags/)
  assert.doesNotMatch(jobOf('flip-back'), /^\s+concurrency:/m)
  assert.doesNotMatch(jobOf('watch'), /^\s+concurrency:/m)
})

test('workflow: a watch that failed or was cancelled without a verdict flips back too', () => {
  const flip = jobOf('flip-back')
  // A cancel re-evaluates each step: every flip-back step must run on always() too.
  const steps = flip.slice(flip.indexOf('\n    steps:\n')).split(/\n      - /).slice(1)
  assert.equal(steps.length, 7)
  for (const step of steps) assert.match(step, /\n\s+if: \$\{\{ always\(\) \}\}/, step.split('\n')[0])
  assert.match(flip, /if: \$\{\{ always\(\) && vars\.ORCA_CLOUD_OPERATIONS_ENABLED == 'true' && needs\.watch\.result != 'skipped'/)
  assert.match(flip, /!contains\(fromJSON\('\["completed","stopped","refused"\]'\), needs\.watch\.outputs\.state\)/)
  // Every segment checks its ID token's shape, and runs the one shared command.
  const segments = watchWorkflow.match(/run: bash -c "\$\{WATCH_SEGMENT\}"/g) ?? []
  assert.equal(segments.length, 6)
  assert.match(jobOf('watch'), /process\.env\.ORCA_RELAY_ADMIN_ID_TOKEN/)
})

test('a live rollout lease refuses the watch before its first sample; an expired one does not', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    const stateFile = join(directory, 'state.json')
    const output = join(directory, 'out')
    const config = parseAt(watchValues({ 'state-file': stateFile, 'github-output': output, 'segment-minutes': '1' }))
    const lease = (expiresAt) => ({ record: { expires_at: expiresAt }, holder: 'Deploy Relay Production Same-Cap (run 9)' })
    let clock = START
    const dependencies = (rolloutLease) => ({
      ...fakeSources({ rolloutLease }),
      idToken: 'id',
      retryDelayMs: 0,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      log: () => {}
    })
    const held = await watchSegment(config, dependencies(lease(START + MINUTE)))
    assert.equal(held.state, 'refused')
    assert.match(held.verdict, /a rollout holds the Cloud SQL rollout lease until .*Same-Cap \(run 9\)/)
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).state, 'refused')
    assert.match(await readFile(output, 'utf8'), /^state=refused\n/)
    await rm(stateFile)
    assert.equal((await watchSegment(config, dependencies(lease(START - 1)))).state, 'watching')
    // Only the first segment checks: a later one carries on from its state file.
    assert.equal((await watchSegment(config, dependencies(lease(clock + MINUTE)))).state, 'watching')
    // A lease it cannot read refuses too, as the lease action fails closed.
    assert.match(await rolloutLeaseRefusal(async () => { throw new Error('403') }, START), /lease is unreadable \(403\)/)
    assert.equal(await rolloutLeaseRefusal(async () => null, START), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const stepOf = (job, name) => {
  const text = jobOf(job)
  const start = text.indexOf(`- name: ${name}\n`)
  assert.notEqual(start, -1, `step ${name} is missing`)
  const end = text.indexOf('\n      - ', start + 1)
  return text.slice(start, end === -1 ? undefined : end)
}
const ALARM_COMMAND = /node dev\/scripts\/watch-relay-reserve-cell\.mjs alarm --kind KIND \\\n\s+--mode "\$\{MODE\}" --cell-id "\$\{CELL_ID\}" --project-id "\$\{GCP_PROJECT_ID\}" --verdict "\$\{VERDICT_VAR\}"/
const alarmCommand = (kind, verdict) => new RegExp(ALARM_COMMAND.source.replace('KIND', kind).replace('VERDICT_VAR', verdict))

test('workflow: a flip back that did not land and a refused watch both raise the alarm', () => {
  const alarm = stepOf('flip-back', 'Alarm when the flip back did not land')
  assert.match(alarm, /if: \$\{\{ always\(\) \}\}/)
  assert.match(alarm, /grep -qs '"event":"orca_relay_reserve_watch_flip_back"' "\$\{RUNNER_TEMP\}\/relay-reserve-flip-back\.jsonl"/)
  assert.match(alarm, alarmCommand('flip-back-failed', 'VERDICT'))
  const refused = stepOf('watch', 'Alarm on a refused watch')
  assert.match(refused, /if: \$\{\{ always\(\) && steps\.outcome\.outputs\.state == 'refused' \}\}/)
  assert.match(refused, /WATCH_VERDICT: \$\{\{ steps\.outcome\.outputs\.verdict \}\}/)
  assert.match(refused, alarmCommand('refused', 'WATCH_VERDICT'))
  // After the outcome step, so it reads the recorded state.
  assert.ok(jobOf('watch').indexOf('- name: Alarm on a refused watch') > jobOf('watch').indexOf('- id: outcome'))
  // The flip-back line names only the write's own event, never its conflict retries.
  assert.match(readFileSync(new URL('./watch-relay-reserve-cell.mjs', import.meta.url), 'utf8'), /event: 'orca_relay_reserve_watch_flip_back',\n/)
})

test('an alarm is an escaped error annotation everywhere, and in write mode a paging log line', async () => {
  const calls = []
  const lines = []
  const runGcloud = async (args, options) => (calls.push({ args, options }), { stdout: '' })
  const alarm = (overrides) =>
    raiseAlarm(
      { mode: 'write', cellId: CELL, projectId: 'onorca-cloud', kind: 'refused', reason: '50%\r\nlease held', ...overrides },
      { runGcloud, log: (line) => lines.push(line) }
    )
  assert.deepEqual(await alarm(), { paged: true })
  assert.equal(
    lines[0],
    `::error title=Reserve watch refused for ${CELL}::${CELL} may be in reserve mode and unwatched: the watch was refused (50%25%0D%0Alease held). ` +
      'Rerun it, or flip the cell to db with Operate Relay Production Cell Flags.'
  )
  assert.deepEqual(calls[0].args, [
    'logging', 'write', ALARM_LOG_NAME,
    JSON.stringify({ event: ALARM_EVENT, cellId: CELL, kind: 'refused', reason: '50%\r\nlease held' }),
    '--payload-type=json', '--severity=ERROR', '--project', 'onorca-cloud'
  ])
  // A dry run never flips back, so its alarm annotates but does not page.
  assert.deepEqual(await alarm({ mode: 'dry-run', kind: 'flip-back-failed' }), { paged: false })
  assert.equal(calls.length, 1)
  assert.match(lines[1], /^::error title=Reserve watch flip-back-failed for production-gce-c26::.*did not land/)
  // A title property escapes its own separators too.
  await alarm({ mode: 'dry-run', cellId: 'a:b,c' })
  assert.match(lines[2], /^::error title=Reserve watch refused for a%3Ab%2Cc::/)
  // A failed log write is named, never swallowed silently.
  const failed = await raiseAlarm(
    { mode: 'write', cellId: CELL, projectId: 'onorca-cloud', kind: 'flip-back-failed', reason: 'x' },
    { runGcloud: async () => { throw new Error('PERMISSION_DENIED') }, log: (line) => lines.push(line) }
  )
  assert.deepEqual(failed, { paged: false })
  assert.match(lines.at(-1), /^::error title=Reserve watch page failed::.*nothing pages: PERMISSION_DENIED/)
  await assert.rejects(alarm({ kind: 'other' }), /--kind must be one of/)
  // A missing project still annotates, then names the page it could not send.
  const before = calls.length
  assert.deepEqual(await alarm({ projectId: undefined }), { paged: false })
  assert.equal(calls.length, before)
  assert.match(lines.at(-2), /^::error title=Reserve watch refused for /)
  assert.match(lines.at(-1), /nothing pages: --project-id is not a GCP project id/)
})

// Step 6 phone rules. A quiet window, minute by minute: ordinary 4401s from phones whose pairing
// was removed, an occasional failed confirm or half-open control. Synthetic: replaying a recorded
// production window needs read access this suite does not have.
const QUIET_PHONE_MINUTE = (index) => ({
  credentialRefusals: [0, 1, 0, 2, 1][index % 5],
  confirmFailures: [0, 0, 1, 0][index % 4],
  attachDeadlines: [1, 0, 2, 0, 1, 3][index % 6],
  acceptDatabaseErrors: 0,
  renewalFailures: 0,
  completedAccepts: [10, 12, 8][index % 3]
})
const phoneRead = (minuteCount, perMinute) => {
  const minutes = Array.from({ length: minuteCount }, (_, index) => `2026-10-19T12:${String(index).padStart(2, '0')}`)
  const rows = minutes.map((_, index) => perMinute(index))
  const series = Object.fromEntries(Object.keys(rows[0]).map((signal) => [signal, rows.map((row) => row[signal])]))
  return { ok: true, minutes, series, unmetered: [] }
}
const memoryCell = (overrides = {}) => healthyCell({ phonePathConfigured: 'memory', resumeAuditDropped: 0, ...overrides })
const phoneState = (overrides = {}) =>
  freshState({
    flippedAt: START - 10 * MINUTE,
    phoneSince: START - 10 * MINUTE,
    phoneBackground: measuredPhoneBackground(phoneRead(10, QUIET_PHONE_MINUTE)),
    ...overrides
  })
// The last 10 minutes as of watch minute `offset`, the newest minutes shaped by `spike`.
const phoneSampleAt = (offset, spike = () => ({}), cell = memoryCell()) =>
  sampleAt(START + offset * MINUTE, {
    cell,
    phone: phoneRead(10, (index) => ({ ...QUIET_PHONE_MINUTE(offset + index), ...spike(index) }))
  })

test('phone rules: a quiet hour replays without a trip', () => {
  const results = run(Array.from({ length: 60 }, (_, offset) => phoneSampleAt(offset)), phoneState({ deadlineAt: START + 120 * MINUTE }))
  assert.equal(results.length, 60)
  assert.ok(results.every((result) => result.state.state === 'watching' && result.state.phoneTrip === null))
  assert.deepEqual(Object.keys(results[0].rules).filter((name) => name.startsWith('phone')), PHONE_RULE_NAMES)
})

test('phone rules: judged as a share of attempts, over half and over the background', () => {
  assert.equal(phoneShareLine(0), 0.5)
  assert.equal(phoneShareLine(0.3), 0.55)
  assert.equal(phoneShareLine(0.5), 0.6)
  // Exactly half is not over; nor is a minute with under 4 attempts.
  assert.equal(phoneMinuteOver('credentialRefusals', 9, 9, 0.5), false)
  assert.equal(phoneMinuteOver('credentialRefusals', 11, 10, 0.5), true)
  assert.equal(phoneMinuteOver('credentialRefusals', 3, 0, 0.5), false)
  assert.equal(phoneMinuteOver('credentialRefusals', 4, 0, 0.5), true)
  // Each accept makes one confirm: every confirm failing is all of them, not half the attempts.
  assert.equal(phoneMinuteOver('confirmFailures', 4, 4, 0.6), true)
  assert.equal(phoneMinuteOver('confirmFailures', 2, 4, 0.5), false)
  assert.equal(phoneMinuteOver('confirmFailures', 9, 3, 0.5), false)
  const background = measuredPhoneBackground(phoneRead(10, () => ({ ...QUIET_PHONE_MINUTE(0), credentialRefusals: 1, completedAccepts: 9 })))
  assert.equal(background.share.credentialRefusals, 0.1)
  assert.equal(measuredPhoneBackground({ ...phoneRead(10, QUIET_PHONE_MINUTE), unmetered: ['2026-10-19T12:03'] }), null)
})

test('phone rules: each fires on its own spike, and the watch goes on with the reserve rules', () => {
  const spikes = {
    phoneCredentialRefusals: { credentialRefusals: 25 },
    phoneConfirmFailures: { confirmFailures: 25 },
    phoneAttachDeadlines: { attachDeadlines: 25 },
    phoneAcceptDatabaseErrors: { acceptDatabaseErrors: 25 }
  }
  for (const [rule, counts] of Object.entries(spikes)) {
    const [result] = run([phoneSampleAt(0, (index) => (index >= 7 ? counts : {}))], phoneState())
    assert.equal(result.state.state, 'watching', rule)
    assert.match(result.state.phoneTrip, new RegExp(`turn off the phone path on ${CELL}: ${rule}: `), rule)
  }
  // Two minutes over the line is not three.
  const [twoMinutes] = run([phoneSampleAt(0, (index) => (index >= 8 ? { credentialRefusals: 25 } : {}))], phoneState())
  assert.equal(twoMinutes.state.phoneTrip, null)
  // Once the watch turned the phone path off, the phone rules stand down.
  const [off] = run([phoneSampleAt(0, () => ({ credentialRefusals: 50 }))], phoneState({ phoneOffAt: START }))
  assert.deepEqual(Object.keys(off.rules).filter((name) => name.startsWith('phone')), [])
})

test('phone rules: judged only while the switch file says memory; reserve rules still flip the cell back', () => {
  const [off] = run([sampleAt(START, { cell: healthyCell({ phonePathConfigured: 'db' }) })], freshState())
  assert.deepEqual(Object.keys(off.rules).filter((name) => name.startsWith('phone')), [])
  const [overrun] = run([phoneSampleAt(0, () => ({}), memoryCell({ enforcedUnits: 2_001 }))], phoneState())
  assert.equal(overrun.state.state, 'tripped')
  assert.equal(overrun.state.flip, 'admitMode')
})

test('phone rules: missing phone data turns off only the phone path, and needs a flipped-at background', () => {
  const gap = (offset) => ({ ...phoneSampleAt(offset), phone: { ...phoneSampleAt(offset).phone, unmetered: ['2026-10-19T12:09'] } })
  const results = run([gap(0), gap(1), gap(2)], phoneState())
  assert.equal(results.at(-1).state.state, 'watching')
  assert.equal(results.at(-1).state.unverifiableStreak, 0)
  assert.match(results.at(-1).state.phoneTrip, /unverifiable: 3 samples/)
  const [noBackground] = run([phoneSampleAt(0)], freshState({ flippedAt: null }))
  assert.match(noBackground.rules.phoneCredentialRefusals.reason, /--flipped-at/)
  // A gap before the judged 3 minutes changes nothing.
  const early = { ...phoneSampleAt(0), phone: { ...phoneSampleAt(0).phone, unmetered: ['2026-10-19T12:02'] } }
  const [earlyGap] = run([early], phoneState())
  assert.equal(earlyGap.rules.phoneCredentialRefusals.status, 'pass')
})

test('phone rules: memory set partway through a watch measures from then, not from the reserve flip', () => {
  const state = freshState({ flippedAt: START - 60 * MINUTE })
  const [before, after] = run([sampleAt(START), phoneSampleAt(1)], state)
  assert.equal(before.state.phoneSince, null)
  assert.equal(after.state.phoneSince, START)
  assert.equal(after.rules.phoneCredentialRefusals.status, 'pending')
})

test('phone rules: audit drops and failing renewals page once when sustained, and flip nothing', () => {
  const dropping = (offset, dropped) => phoneSampleAt(offset, () => ({}), memoryCell({ resumeAuditDropped: dropped }))
  // One drop, then none: no page.
  const single = run([dropping(0, 0), dropping(1, 1), ...Array.from({ length: 8 }, (_, index) => dropping(index + 2, 1))], phoneState())
  assert.ok(single.every((result) => result.pages.length === 0))
  const rising = run(Array.from({ length: 9 }, (_, offset) => dropping(offset, offset * 3)), phoneState())
  assert.deepEqual(rising.map((result) => result.pages.join()), ['', '', '', '', '', '', 'audit-drops', '', ''])
  const renewing = run(Array.from({ length: 7 }, (_, offset) => phoneSampleAt(offset, () => ({ renewalFailures: 1 }))), phoneState())
  assert.deepEqual(renewing.map((result) => result.pages.join()).filter(Boolean), ['renewal-failures'])
  assert.ok([...rising, ...renewing].every((result) => result.state.state === 'watching' && result.state.phoneTrip === null))
})

test('the cell phone read sums each minute from the cell runtime metrics lines, and refuses an old image', async () => {
  const endedAt = Date.parse('2026-10-19T12:03:00Z')
  const line = (at, payload) => ({
    timestamp: new Date(at).toISOString(),
    jsonPayload: {
      phoneRejectionsByCodeDelta: {},
      resumeConfirmFailuresByCodeDelta: {},
      phoneAttachDeadlinesDelta: 0,
      phoneAcceptDatabaseErrorsDelta: 0,
      resumeRenewalFailuresDelta: 0,
      clientAcceptCompletedDelta: 0,
      ...payload
    }
  })
  let filter
  const read = await readCellPhoneMinutes(
    fakeReader({
      runGcloud: async (args) => {
        filter = args[2]
        return {
          stdout: JSON.stringify([
            line(endedAt - 150_000, { phoneRejectionsByCodeDelta: { 4401: 2, 4404: 9 } }),
            line(endedAt - 120_000, { resumeConfirmFailuresByCodeDelta: { 'reject-revoked': 1, error: 2 } }),
            line(endedAt - 90_000, { phoneAttachDeadlinesDelta: 3, phoneAcceptDatabaseErrorsDelta: 1, resumeRenewalFailuresDelta: 4, clientAcceptCompletedDelta: 7 })
          ])
        }
      }
    }),
    { cellId: CELL, endedAt, minutes: 3 }
  )
  assert.match(filter, /resource\.type="gce_instance"/)
  assert.match(filter, new RegExp(`jsonPayload\\.cellId="${CELL}"`))
  assert.deepEqual(read.series, {
    credentialRefusals: [2, 0, 0],
    confirmFailures: [3, 0, 0],
    attachDeadlines: [0, 3, 0],
    acceptDatabaseErrors: [0, 1, 0],
    renewalFailures: [0, 4, 0],
    completedAccepts: [0, 7, 0]
  })
  assert.deepEqual(read.unmetered, ['2026-10-19T12:02'])
  const old = await readCellPhoneMinutes(
    fakeReader({ runGcloud: async () => ({ stdout: JSON.stringify([{ timestamp: new Date(endedAt - 1).toISOString(), jsonPayload: {} }]) }) }),
    { cellId: CELL, endedAt, minutes: 3 }
  )
  assert.match(old.error, /no phone counters/)
  assert.equal(old.permanent, true)
})

// The watch over a memory cell whose phone metrics come from `phoneMetrics(at)`.
async function phoneWatch(phoneMetrics, minutes) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    let clock = START
    const lines = []
    const config = parseAt(watchValues({ 'state-file': join(directory, 'state.json'), 'segment-minutes': String(minutes) }))
    const sources = fakeSources({
      cell: () => ({ flagsApplied: { generation: 4, flags: { admitMode: 'reserve', readinessLocal: true, phonePath: 'memory' } } })
    })
    const runGcloud = async (args) =>
      args[2]?.includes('gce_instance') ? { stdout: JSON.stringify(metricsLines(args[2], (at) => [phoneMetrics(at)])) } : sources.runGcloud(args)
    const state = await watchSegment(config, {
      ...sources,
      runGcloud,
      idToken: 'id',
      accessToken: 'access',
      audit: {},
      retryDelayMs: 0,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      log: (line) => lines.push(line)
    })
    return { state, lines }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
const phoneCounters = (overrides = {}) => ({
  phoneRejectionsByCodeDelta: {},
  resumeConfirmFailuresByCodeDelta: {},
  phoneAttachDeadlinesDelta: 0,
  phoneAcceptDatabaseErrorsDelta: 0,
  resumeRenewalFailuresDelta: 0,
  clientAcceptCompletedDelta: 5,
  ...overrides
})

test('a phone trip whose phonePath=db write fails keeps watching, retries each sample, and pages after 3 failures', async () => {
  // No bucket here, so every write fails.
  const { state, lines } = await phoneWatch((at) => phoneCounters(at > START ? { phoneAttachDeadlinesDelta: 20 } : {}), 15)
  assert.equal(state.state, 'watching')
  assert.equal(state.phoneOffAt, null)
  assert.match(state.phoneTrip, /phoneAttachDeadlines: /)
  const failures = lines.filter((line) => line.includes('orca_relay_reserve_watch_phone_path_off_failed'))
  assert.ok(failures.length > 3, `${failures.length} failed writes`)
  assert.equal(state.phoneOffFailures, failures.length)
  const alarms = lines.filter((line) => line.includes('may still have phonePath=memory'))
  assert.equal(alarms.length, 1)
})

test('a phone trip still unwritten when the watch ends leaves it to the flip back', () => {
  const [last] = run([phoneSampleAt(0)], phoneState({ deadlineAt: START, phoneTrip: 'turn off the phone path on x: phoneAttachDeadlines: y' }))
  assert.equal(last.state.state, 'tripped')
  assert.equal(last.state.flip, 'phonePath')
  assert.match(last.state.verdict, /phoneAttachDeadlines: y; phonePath=db did not land before the watch ended/)
})

test('a phone background broken by a restart or roll refuses the watch instead of turning phones off for certain', async () => {
  const { state } = await phoneWatch((at) => (at < START - 8 * MINUTE ? {} : phoneCounters()), 5)
  assert.equal(state.state, 'refused')
  assert.match(state.verdict, /phone background.*incomplete.*later --flipped-at/)
})

test('a phone-rule flip back removes phonePath, and does nothing once the file no longer says memory', async () => {
  const { fetchImpl, calls } = fakeFlipBack({ flags: { admitMode: 'reserve', readinessLocal: true, phonePath: 'memory' } })
  const result = await flipBack(flipValues({ flip: 'phonePath' }), flipDependencies(fetchImpl, []))
  assert.equal(result.written, true)
  const upload = calls.find((call) => call.url.includes('/upload/storage/v1/'))
  assert.match(upload.body, /"flags":\{"admitMode":"reserve","readinessLocal":true\}/)
  assert.ok(!calls.some((call) => call.url.endsWith('/v1/admin/cell-admit-mode') && JSON.parse(call.body).admitMode))
  const done = await flipBack(flipValues({ flip: 'phonePath' }), flipDependencies(fakeFlipBack().fetchImpl, []))
  assert.equal(done.alreadyDb, true)
})

test('both flip backs land on a cell rolled back to an image without the phonePath switch', async () => {
  const flags = { admitMode: 'reserve', readinessLocal: true, phonePath: 'memory' }
  for (const flip of ['admitMode', 'phonePath']) {
    const { fetchImpl, calls } = fakeFlipBack({ flags, supportedFlags: { admitMode: { type: 'enum', values: ['db', 'reserve'] }, readinessLocal: { type: 'boolean' } } })
    const result = await flipBack(flipValues({ flip }), flipDependencies(fetchImpl, []))
    assert.equal(result.written, true, flip)
    const upload = calls.find((call) => call.url.includes('/upload/storage/v1/'))
    assert.doesNotMatch(upload.body, /phonePath/, flip)
  }
})

test('workflow: the flip back writes what the watch says tripped, and the whole cell when it says nothing', () => {
  const workflow = watchWorkflow
  assert.match(workflow, /flip: \$\{\{ steps\.outcome\.outputs\.flip \}\}/)
  assert.match(workflow, /FLIP: \$\{\{ needs\.watch\.outputs\.flip \|\| 'admitMode' \}\}/)
  assert.match(workflow, /--flip "\$\{FLIP\}"/)
  // A failed phone flip back pages with the phone wording.
  assert.match(workflow, /--verdict "\$\{VERDICT\}" --flip "\$\{FLIP\}"\n/)
  assert.match(workflow, /ORCA_RELAY_CONTROL_ACCESS_TOKEN="\$\(gcloud auth print-access-token\)"\n\s+echo "::add-mask::/)
})


test('a failed phone flip back and the phone pages say what is still on', async () => {
  const lines = []
  const runGcloud = async () => ({ stdout: '' })
  await raiseAlarm({ mode: 'dry-run', cellId: CELL, projectId: 'onorca-cloud', kind: 'flip-back-failed', reason: 'x', flip: 'phonePath' }, { runGcloud, log: (line) => lines.push(line) })
  await raiseAlarm({ mode: 'dry-run', cellId: CELL, projectId: 'onorca-cloud', kind: 'renewal-failures', reason: 'y' }, { runGcloud, log: (line) => lines.push(line) })
  assert.match(lines[0], /may still have phonePath=memory/)
  assert.doesNotMatch(lines[0], /reserve mode/)
  assert.match(lines[1], /cannot renew phone credentials/)
})

// Recorded, not synthetic: 26 h of c7, c28 and c29 runtime metrics (read-only, 10-18/19). The phone
// counters are not on those images yet, so auth failures (host and phone 4401s, an over-count)
// stand in for the refused or failed attempts, against completed accepts. They cannot stand in for
// confirm failures: c28's 04:08Z minutes (9/9, 9/9, 11/10) read as confirms are a total outage.
const PHONE_RULE_SIGNAL_NAMES = ['credentialRefusals', 'confirmFailures', 'attachDeadlines', 'acceptDatabaseErrors']
const recordedPhoneMinutes = JSON.parse(readFileSync(new URL('./relay-phone-watch-recorded-quiet-minutes.json', import.meta.url), 'utf8')).cells
// The minute index a recorded watch of `signal` from `start` trips at, or null; `minute(i)` may rewrite a minute.
function recordedTrip({ authFailuresPerMinute: failures, completedAcceptsPerMinute: accepts }, signal, start, watchMinutes, minute = (i) => [failures[i], accepts[i]]) {
  const { readMinutes, consecutiveMinutes } = PHONE_WATCH_RULES
  const refused = failures.slice(start - readMinutes, start)
  const background = measuredPhoneBackground({
    ok: true,
    minutes: refused,
    unmetered: [],
    series: { ...Object.fromEntries(PHONE_RULE_SIGNAL_NAMES.map((name) => [name, refused])), completedAccepts: accepts.slice(start - readMinutes, start) }
  })
  const line = phoneShareLine(background.share[signal])
  let run = 0
  for (let index = start; index < start + watchMinutes; index += 1) {
    run = phoneMinuteOver(signal, ...minute(index), line) ? run + 1 : 0
    if (run >= consecutiveMinutes) return index
  }
  return null
}

test('phone rules: 26 recorded hours of c7, c28 and c29 trip no attempt rule in any 60- or 300-minute watch', () => {
  assert.deepEqual(Object.keys(recordedPhoneMinutes), ['production-gce-c7', 'production-gce-c28', 'production-gce-c29'])
  for (const [cell, minutes] of Object.entries(recordedPhoneMinutes)) {
    for (const watchMinutes of [60, 300]) {
      for (let start = 10; start + watchMinutes <= minutes.authFailuresPerMinute.length; start += 5) {
        assert.equal(recordedTrip(minutes, 'credentialRefusals', start, watchMinutes), null, `${cell}: a ${watchMinutes}-min watch from minute ${start} trips`)
      }
    }
  }
})

// From minute 30 of each recorded hour, a broken path; it must trip by its third minute (sooner
// when the minute before was already over) wherever those minutes carry 4 attempts each.
const BROKEN_PATHS = {
  'two refusals per accept': ['credentialRefusals', (failed, accepted) => [Math.max(2 * accepted, 4), accepted]],
  'every accept errors on the database, phones give up after one try': ['acceptDatabaseErrors', (failed, accepted) => [accepted, 0]],
  // Only trips are tested: the auth-failure stand-in cannot measure confirm false trips.
  'every confirm fails': ['confirmFailures', (failed, accepted) => [accepted, accepted]]
}
test('phone rules: the same recorded hours trip on each broken path wherever its minutes are judged', () => {
  for (const [name, [signal, breakMinute]] of Object.entries(BROKEN_PATHS)) {
    for (const [cell, minutes] of Object.entries(recordedPhoneMinutes)) {
      const { authFailuresPerMinute: failures, completedAcceptsPerMinute: accepts } = minutes
      let judged = 0
      for (let start = 10; start + 60 <= failures.length; start += 5) {
        const broken = (index) => (index >= start + 30 ? breakMinute(failures[index], accepts[index]) : [failures[index], accepts[index]])
        const judgedMinutes = [0, 1, 2].every((offset) => {
          const [count, accepted] = broken(start + 30 + offset)
          return (signal === 'confirmFailures' ? accepted : count + accepted) >= PHONE_WATCH_RULES.minAttemptsPerMinute
        })
        if (!judgedMinutes) continue
        judged += 1
        const at = recordedTrip(minutes, signal, start, 60, broken)
        // Confirms may trip earlier: the stand-in reads as failing confirms on c28 (see above).
        const earliest = signal === 'confirmFailures' ? start : start + 30
        assert.ok(at !== null && at >= earliest && at <= start + 32, `${cell} ${name}: from minute ${start + 30} trips at ${at}`)
      }
      // Busy cells are judged most of the day; low-volume c7 rarely reaches 4 attempts a minute.
      if (cell !== 'production-gce-c7') assert.ok(judged > 150, `${cell} ${name}: ${judged} judged`)
    }
  }
})
