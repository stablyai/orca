import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readRelayWorkflow } from './relay-repository.mjs'
import {
  READ_ATTEMPTS,
  evaluateShadowGate,
  parseShadowGateArguments
} from './relay-same-cap-shadow-gate.mjs'
import {
  ENTRY_LIMIT,
  FLEET_POOL_CELL_IDS,
  PACE_CHECKS,
  SHADOW_GATE_THRESHOLDS,
  SUB_WINDOW_MINUTES,
  backgroundOf,
  combineVerdict,
  countByMinute,
  drainReturnByMinute,
  formatTimestamp,
  judgeCellServing,
  judgeCloudSqlFatal,
  judgeDrainDeferrals,
  judgeNonDrain503Budget,
  judgePool,
  longestRunAtOrAbove,
  renderStepSummary,
  resolveWindow,
  splitWindow,
  withoutDrainDeferrals
} from './relay-same-cap-shadow-gate-verdict.mjs'

const ARGV = [
  '--cell-id', 'production-gce-c28',
  '--cell-host', 'c28.relay.onorca.dev',
  '--project-id', 'onorca-cloud',
  '--director-service', 'orca-cloud-relay',
  '--drain-started-at', '2026-09-20T20:00:00Z',
  '--apply-started-at', '2026-09-20T20:15:00Z',
  '--apply-completed-at', '2026-09-20T20:19:30Z',
  '--verify-ended-at', '2026-09-20T20:30:00Z',
  '--output-file', '/tmp/shadow.json',
  '--drain-pace-window-ms', '300000',
  '--drain-applied-pace-window-ms', '300000',
  '--drain-settled-at', '2026-09-20T20:11:00Z',
  '--target-hosts', '857'
]

function minuteOfTimestamps(minute, count) {
  return Array.from(
    { length: count },
    (_, index) => `${minute}:${String(index % 60).padStart(2, '0')}Z`
  )
}

test('binds every gcloud input to a pinned pattern and to one cell', () => {
  assert.equal(parseShadowGateArguments(ARGV).cellId, 'production-gce-c28')
  // A filter is a string; anything that could steer one has to be refused before it is built.
  assert.throws(() => parseShadowGateArguments(ARGV.with(1, 'production-gce-c28" OR "x')))
  assert.throws(() => parseShadowGateArguments(ARGV.with(3, 'evil.example.test')))
  assert.throws(() => parseShadowGateArguments(ARGV.with(5, 'Onorca Cloud')))
  assert.throws(() => parseShadowGateArguments(ARGV.with(7, 'orca cloud relay')))
  // Host and cell id must name the same cell, or the serving check reads a neighbour.
  assert.throws(() => parseShadowGateArguments(ARGV.with(3, 'c29.relay.onorca.dev')))
  // A run with nowhere to write its verdict is not a report-only run, it is a silent one.
  assert.throws(
    () => parseShadowGateArguments(ARGV.filter((_, index) => index !== 16 && index !== 17)),
    /--output-file is required/
  )
  // The pace is the rung this roll is evidence for, so it has to be one the wave could run.
  for (const pace of ['', '120000', '30000 OR x']) {
    assert.throws(() => parseShadowGateArguments(ARGV.with(19, pace)), /drain-pace-window-ms/)
  }
  assert.throws(() => parseShadowGateArguments(ARGV.with(21, '-1')), /drain-applied/)
  assert.throws(() => parseShadowGateArguments(ARGV.with(23, 'soon')), /drain-settled-at/)
  // A resumed rollback never drains, so it has no applied pace, settle time, or host count.
  const resumed = parseShadowGateArguments(ARGV.with(21, '').with(23, '').with(25, ''))
  assert.equal(resumed.drainAppliedPaceWindowMs, null)
  assert.equal(resumed.targetHosts, null)
})

test('the window runs from drain start to verify end, with named fallbacks', () => {
  const full = resolveWindow({
    drainStartedAt: '2026-09-20T20:00:00Z',
    applyStartedAt: '2026-09-20T20:15:00Z',
    verifyEndedAt: '2026-09-20T20:30:00Z'
  })
  assert.equal(formatTimestamp(full.startedAt), '2026-09-20T20:00:00Z')
  assert.equal(full.startedFrom, 'drain')
  // A resumed rollback never drains, so the apply stands in for the start.
  assert.equal(resolveWindow({
    applyStartedAt: '2026-09-20T20:15:00Z',
    verifyEndedAt: '2026-09-20T20:30:00Z'
  }).startedFrom, 'apply')
  assert.equal(formatTimestamp(resolveWindow({
    verifyEndedAt: '2026-09-20T20:30:00Z'
  }).startedAt), '2026-09-20T20:00:00Z')
  assert.throws(() => resolveWindow({
    drainStartedAt: '2026-09-20T20:30:00Z',
    verifyEndedAt: '2026-09-20T20:30:00Z'
  }))
  assert.throws(() => resolveWindow({ verifyEndedAt: 'not-a-time' }))
})

test('reads are split into sub-windows no longer than the truncation bound', () => {
  const windows = splitWindow(resolveWindow({
    drainStartedAt: '2026-09-20T20:00:00Z',
    verifyEndedAt: '2026-09-20T20:47:00Z'
  }))
  assert.equal(windows.length, 5)
  for (const window of windows) {
    const minutes = (window.endedAt - window.startedAt) / 60_000
    assert.ok(minutes > 0 && minutes <= SUB_WINDOW_MINUTES, `${minutes} minutes`)
  }
  assert.equal(formatTimestamp(windows.at(-1).endedAt), '2026-09-20T20:47:00Z')
})

test('a sub-window that came back at the entry limit is truncated, never a count', () => {
  const truncated = countByMinute([
    { timestamps: minuteOfTimestamps('2026-09-19T15:34', ENTRY_LIMIT) }
  ])
  assert.equal(truncated.truncated, true)
  const failed = countByMinute([{ failed: true, timestamps: [] }])
  assert.equal(failed.truncated, true)
  const counted = countByMinute([
    { timestamps: minuteOfTimestamps('2026-09-19T15:34', 4722) },
    { timestamps: minuteOfTimestamps('2026-09-19T15:33', 278) }
  ])
  assert.deepEqual(
    {
      peak: counted.peak,
      peakMinute: counted.peakMinute,
      total: counted.total,
      truncated: counted.truncated
    },
    { peak: 4722, peakMinute: '2026-09-19T15:34', total: 5000, truncated: false }
  )
})

test('the cell has to announce its listener and stay up across the whole apply', () => {
  assert.equal(judgeCellServing({
    listeningAt: '2026-09-20T20:18:27Z',
    crashesSinceApply: 0
  }).status, 'pass')
  assert.equal(judgeCellServing({ listeningAt: null }).status, 'would-block')
  // A resumed rollback restarts nothing, so there is no boot to find and silence proves nothing.
  assert.equal(judgeCellServing({ listeningAt: null, expectBoot: false }).status, 'unverified')
  assert.equal(judgeCellServing({
    listeningAt: '2026-09-20T20:18:27Z',
    crashesSinceApply: 1
  }).status, 'would-block')
  assert.equal(judgeCellServing({
    listeningAt: null,
    read: { failed: true }
  }).status, 'unverified')
})

test('pool pressure blocks only when it persists across consecutive samples', () => {
  assert.equal(longestRunAtOrAbove([10, 60, 10, 60, 60, 60, 10], 50), 3)
  const burst = judgePool({
    label: 'production-gce-c27',
    // The single-sample waiters=71 that a literal rule called an outage.
    samples: [
      { databasePoolWaitersMax: 12 },
      { databasePoolWaitersMax: 71 },
      { databasePoolWaitersMax: 9 }
    ]
  })
  assert.equal(burst.status, 'warn')
  assert.equal(burst.consecutiveSamplesOverWaitersThreshold, 1)
  assert.equal(judgePool({
    label: 'production-gce-c28',
    samples: [
      { databasePoolWaitersMax: 148 },
      { databasePoolWaitersMax: 125 },
      { databasePoolWaitersMax: 154 }
    ]
  }).status, 'would-block')
  assert.equal(judgePool({
    label: 'production-gce-c28',
    samples: [{ databasePoolWaitersMax: 2, sqlFailuresDelta: 489 }]
  }).status, 'would-block')
  assert.equal(judgePool({
    label: 'production-gce-c29',
    samples: [{ databasePoolWaitersMax: 3, sqlFailuresDelta: 0, totalConnections: 500 }]
  }).status, 'pass')
  // No samples at all is silence, not health.
  assert.equal(judgePool({ label: 'production-gce-c29', samples: [] }).status, 'unverified')
  assert.equal(judgePool({
    label: 'production-gce-c29',
    samples: [{ databasePoolWaitersMax: 1 }],
    failed: true
  }).status, 'unverified')
  // A truncated sample run has holes, and a hole reads to the run rule as a recovery.
  assert.equal(judgePool({
    label: 'production-gce-c29',
    samples: [{ databasePoolWaitersMax: 1 }],
    truncated: true
  }).status, 'unverified')
  // So is a run read across holes, which may join two separate runs into one.
  assert.equal(judgePool({
    label: 'production-gce-c29',
    samples: Array.from({ length: 3 }, () => ({ databasePoolWaitersMax: 80 })),
    truncated: true
  }).status, 'unverified')
  // But one sample past the failure line is a fact, whatever the read missed.
  assert.equal(judgePool({
    label: 'production-gce-c29',
    samples: [{ databasePoolWaitersMax: 1, sqlFailuresDelta: 201 }],
    truncated: true
  }).status, 'would-block')
})

test('Cloud SQL FATALs warn from the first one and block on a run of them', () => {
  assert.equal(judgeCloudSqlFatal({ count: 0 }).status, 'pass')
  assert.equal(judgeCloudSqlFatal({ count: 1 }).status, 'warn')
  assert.equal(judgeCloudSqlFatal({ count: 21 }).status, 'would-block')
  assert.equal(judgeCloudSqlFatal({ count: 0, truncated: true }).status, 'unverified')
  // A truncated count is a floor: already past the block line, more entries only add to it.
  assert.equal(judgeCloudSqlFatal({ count: 20000, truncated: true }).status, 'would-block')
  assert.equal(judgeCloudSqlFatal({ count: 5, truncated: true }).status, 'unverified')
})

test('the verdict is the worst check, and an unverified read never reads as PASS', () => {
  assert.equal(combineVerdict({ a: { status: 'pass' }, b: { status: 'pass' } }), 'PASS')
  assert.equal(combineVerdict({ a: { status: 'pass' }, b: { status: 'warn' } }), 'WARN')
  assert.equal(combineVerdict({ a: { status: 'pass' }, b: { status: 'unverified' } }), 'WARN')
  assert.equal(
    combineVerdict({ a: { status: 'would-block' }, b: { status: 'unverified' } }),
    'WOULD_BLOCK'
  )
})

// The step that owns each stamp, so a stamp's presence is judged where it has to be written.
const STAMP_STEPS = {
  drain: '- name: Reversibly isolate and drain only the selected cell',
  apply: '- name: Apply only the selected same-cap template and MIG',
  'verify-target': '- name: Verify new incarnation, exact image, protocol, and durable safety'
}

// One step's own lines: from its marker to the next sibling step at the same indent.
function stepBody(workflow, marker) {
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `the job no longer has a step named ${marker}`)
  const next = workflow.indexOf('\n      - ', start + marker.length)
  return workflow.slice(start, next === -1 ? undefined : next)
}

const C28_INSTANCE = '5031087219978409220'

// Runtime-metrics samples at the 30 s cadence production emits them at, unless a case needs
// enough of them inside one sub-window to reach the read's limit.
function metricSamples({ cellId, from, count, payload = {}, intervalMs = 30_000 }) {
  return Array.from({ length: count }, (_, index) => ({
    matches: ['orca_relay_runtime_metrics', `jsonPayload.cellId="${cellId}"`],
    timestamp: new Date(Date.parse(from) + index * intervalMs).toISOString(),
    payload: {
      totalConnections: 857,
      databasePoolWaitersMax: 4,
      databasePoolWaiting: 1,
      sqlFailuresDelta: 0,
      reconnectsDelta: 0,
      ...payload
    }
  }))
}

// The exact entry shapes production returned for c28 on 2026-09-20: the crash at 20:18:10Z and
// the listener at 20:18:27Z, both on instance 5031087219978409220.
function productionLikeEntries() {
  return [
    {
      matches: ['listening on https://c28.relay.onorca.dev'],
      timestamp: '2026-09-20T20:18:27.470301969Z',
      instanceId: C28_INSTANCE
    },
    ...metricSamples({ cellId: 'production-gce-c28', from: '2026-09-20T20:20:00Z', count: 20 }),
    ...metricSamples({ cellId: 'production-gce-c27', from: '2026-09-20T20:20:00Z', count: 20 }),
    ...metricSamples({ cellId: 'production-gce-c29', from: '2026-09-20T20:20:00Z', count: 20 }),
    ...metricSamples({ cellId: 'production-gce-c30', from: '2026-09-20T20:20:00Z', count: 20 }),
    ...metricSamples({ cellId: 'production-gce-c31', from: '2026-09-20T20:20:00Z', count: 20 }),
    ...metricSamples({ cellId: 'production-gce-c34', from: '2026-09-20T20:20:00Z', count: 20 }),
    // One director instance's samples from ten minutes before the drain to the window's end.
    ...directorSamples({ from: '2026-09-20T19:50:00Z', count: 80, payload: {} })
  ]
}

/**
 * A gcloud seam that honours the filter it is given: its timestamp bounds, its instance-id scope,
 * the `--limit`, and the newest-first order. A fake that ignored the bounds would let a
 * wrongly-bounded query pass, which is exactly the bug class these tests exist to catch.
 */
function gcloudSeam(entries = productionLikeEntries()) {
  const calls = []
  const monitoringCalls = []
  return {
    calls,
    monitoringCalls,
    retryDelayMs: 0,
    // Cloud Monitoring's request counter, aligned per minute: one point per minute that had any,
    // stamped at the end of the minute it counts, inside the requested interval only.
    fetch: async (url, init) => {
      const query = new URL(url).searchParams
      monitoringCalls.push({ query, init })
      const startedAt = Date.parse(query.get('interval.startTime'))
      const endedAt = Date.parse(query.get('interval.endTime'))
      const points = entries
        .filter((entry) => entry.minute503 !== undefined)
        .map((entry) => ({ endedAt: Date.parse(`${entry.minute503}:00Z`) + 60_000, count: entry.count }))
        .filter((point) => point.endedAt > startedAt && point.endedAt <= endedAt)
        .map((point) => ({
          interval: { endTime: new Date(point.endedAt).toISOString() },
          value: { int64Value: String(point.count) }
        }))
      return { ok: true, json: async () => ({ timeSeries: points.length ? [{ points }] : [] }) }
    },
    runGcloud: async (args, options) => {
      if (args[0] === 'auth') return { stdout: 'token\n' }
      const filter = args[2]
      const limit = Number(args[args.indexOf('--limit') + 1])
      calls.push({ filter, limit, options })
      const startedAt = Date.parse(/timestamp>="([^"]+)"/.exec(filter)[1])
      const endedAt = Date.parse(/timestamp<"([^"]+)"/.exec(filter)[1])
      const instanceId = /resource\.labels\.instance_id="([^"]+)"/.exec(filter)?.[1]
      const matched = entries.filter((entry) => {
        if (entry.minute503 !== undefined) return false
        const at = Date.parse(entry.timestamp)
        if (at < startedAt || at >= endedAt) return false
        if (instanceId && entry.instanceId !== instanceId) return false
        return entry.matches.every((needle) => filter.includes(needle))
      })
      matched.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
      return {
        stdout: JSON.stringify(matched.slice(0, limit).map((entry) => ({
          timestamp: entry.timestamp,
          ...(entry.instanceId ? { resource: { labels: { instance_id: entry.instanceId } } } : {}),
          ...(entry.payload ? { jsonPayload: entry.payload } : {})
        })))
      }
    }
  }
}

test('reads every promoted asia-east2 cell as fleet pool, C34 included', () => {
  assert.deepEqual(FLEET_POOL_CELL_IDS, [
    'production-gce-c27', 'production-gce-c28', 'production-gce-c29', 'production-gce-c30',
    'production-gce-c31', 'production-gce-c34'
  ])
})

test('a healthy roll reads as PASS and names the instance it proved serving', async () => {
  const seam = gcloudSeam()
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.reportOnly, true)
  assert.equal(report.cellInstanceId, C28_INSTANCE)
  assert.equal(report.window.startedFrom, 'drain')
  assert.equal(report.window.applyCompletedAt, '2026-09-20T20:19:30Z')
  assert.deepEqual(Object.keys(report.checks).sort(), [
    'cellPool',
    'cellServing',
    'cloudSqlFatal',
    'drainDeferrals',
    'fleetPool:production-gce-c27',
    'fleetPool:production-gce-c29',
    'fleetPool:production-gce-c30',
    'fleetPool:production-gce-c31',
    'fleetPool:production-gce-c34',
    'nonDrain503Budget'
  ])
  assert.deepEqual(report.drain, {
    paceWindowMs: 300_000,
    appliedPaceWindowMs: 300_000,
    targetHosts: 857,
    settledAt: '2026-09-20T20:11:00Z',
    settledAfterSeconds: 660
  })
  // Every read carries explicit bounds: --freshness does not bind on these logs.
  for (const { filter } of seam.calls) {
    assert.match(filter, /timestamp>="[^"]+" AND timestamp<"[^"]+"/)
  }
  // Cell text lives in jsonPayload.message; a textPayload filter matches nothing and says so.
  assert.equal(seam.calls.some(({ filter }) => filter.includes('textPayload')), false)
  assert.match(renderStepSummary(report), /Shadow health gate \(report only\): PASS/)
  assert.match(renderStepSummary(report), /Drain pace 300000 ms \(cell applied: 300000\), 857 hosts/)
})

// The listener lands while the MIG is still converging, so a boot search opening at the apply's
// completion finds nothing and calls a healthy roll a failure.
test('the boot search opens at the apply start, not at its completion', async () => {
  const seam = gcloudSeam()
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.checks.cellServing.status, 'pass')
  assert.equal(report.checks.cellServing.listeningAt, '2026-09-20T20:18:27.470301969Z')
  const listenerRead = seam.calls.find(({ filter }) => filter.includes('listening on https://'))
  assert.match(listenerRead.filter, /timestamp>="2026-09-20T20:15:00Z"/)
  // The listener at 20:18:27 sits after the apply start and before its completion at 20:19:30,
  // so a completion-bounded search would have missed it entirely.
  assert.ok(Date.parse('2026-09-20T20:18:27.470301969Z') < Date.parse('2026-09-20T20:19:30Z'))
})

// A crash-restart loop ends with a listener announcement that looks like a clean boot. Counting
// crashes only after the last announcement erases the loop that produced it.
test('a crash before the final listener still counts against the roll', async () => {
  const seam = gcloudSeam([
    ...productionLikeEntries(),
    {
      matches: ['throw er'],
      timestamp: '2026-09-20T20:18:10.651702662Z',
      instanceId: C28_INSTANCE
    }
  ])
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.checks.cellServing.crashesSinceApply, 1)
  assert.equal(report.checks.cellServing.status, 'would-block')
  assert.equal(report.verdict, 'WOULD_BLOCK')
  const crashRead = seam.calls.find(({ filter }) => filter.includes('throw er'))
  // Bounded at the apply start, and still scoped to the instance the listener identified.
  assert.match(crashRead.filter, /timestamp>="2026-09-20T20:15:00Z"/)
  assert.match(crashRead.filter, new RegExp(`resource\\.labels\\.instance_id="${C28_INSTANCE}"`))
})

test('a crash on a neighbouring instance is not charged to this cell', async () => {
  const seam = gcloudSeam([
    ...productionLikeEntries(),
    { matches: ['throw er'], timestamp: '2026-09-20T20:18:10Z', instanceId: '9999999999999999999' }
  ])
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.checks.cellServing.crashesSinceApply, 0)
  assert.equal(report.checks.cellServing.status, 'pass')
})

// A sample run returned at the read's limit has holes, and the consecutive-sample rule reads a
// hole as a recovery, so it must not be judged as though it were complete.
test('a runtime-metrics read at its limit is unverified, not a calm cell', async () => {
  const seam = gcloudSeam([
    ...productionLikeEntries(),
    // 600 samples packed into the first sub-window, past the 500-entry read limit.
    ...metricSamples({
      cellId: 'production-gce-c28',
      from: '2026-09-20T20:00:00Z',
      count: 600,
      intervalMs: 500,
      payload: { databasePoolWaitersMax: 1 }
    })
  ])
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.checks.cellPool.status, 'unverified')
  assert.equal(report.checks.cellPool.truncated, true)
  // The neighbours were read normally, so only the truncated cell is unverified.
  assert.equal(report.checks['fleetPool:production-gce-c27'].status, 'pass')
  assert.equal(report.verdict, 'WARN')
})

test('a resume, which restarts nothing, does not read a missing boot as a failure', async () => {
  const resumed = ARGV.with(9, '').with(11, '').with(13, '')
  const seam = gcloudSeam(productionLikeEntries().filter(
    (entry) => !entry.matches[0].startsWith('listening')
  ))
  const report = await evaluateShadowGate(parseShadowGateArguments(resumed), seam)
  assert.equal(report.window.startedFrom, 'fallback')
  assert.equal(report.checks.cellServing.status, 'unverified')
  assert.equal(report.verdict, 'WARN')
})

test('a gcloud read that never completes is unverified, not a crashed gate', async () => {
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), {
    retryDelayMs: 0,
    runGcloud: async () => { throw new Error('PERMISSION_DENIED') }
  })
  assert.equal(report.verdict, 'WARN')
  assert.equal(report.checks.nonDrain503Budget.status, 'unverified')
  assert.equal(report.checks.cellServing.status, 'unverified')
})

// continue-on-error bounds the job's outcome but not its clock; an unbounded read could spend the
// rollout's remaining minutes before the job's own timeout noticed.
test('every read is given a bounded timeout, and a timed-out read is just a failed read', async () => {
  const seam = gcloudSeam()
  await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.ok(seam.calls.length > 0)
  for (const { options } of seam.calls) {
    assert.equal(options.timeoutMs, SHADOW_GATE_THRESHOLDS.readTimeoutMs)
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 120_000)
  }
  const timedOut = await evaluateShadowGate(parseShadowGateArguments(ARGV), {
    retryDelayMs: 0,
    runGcloud: async () => { throw Object.assign(new Error('ETIMEDOUT'), { killed: true }) }
  })
  assert.equal(timedOut.checks.nonDrain503Budget.status, 'unverified')
  assert.equal(timedOut.verdict, 'WARN')
})

// The reads are serialised, so the cost of a failure that makes every one of them spend its full
// retry budget scales with the window. The deadline is what turns that into a verdict rather than
// a cancelled job, which would take every later cell in the wave with it.
test('the gate stops reading at its own deadline and still reports a verdict', async () => {
  const seam = gcloudSeam()
  // A clock where every read costs its whole retry budget, which is the case the deadline exists
  // for: an expired credential or a Logging 429 storm answers nothing, slowly, every time.
  let elapsedMs = 0
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), {
    ...seam,
    now: () => {
      elapsedMs += SHADOW_GATE_THRESHOLDS.readTimeoutMs * READ_ATTEMPTS
      return elapsedMs
    }
  })
  // Everything past the deadline is skipped rather than attempted, so the gate cannot outlive it.
  assert.ok(seam.calls.length > 0, 'the gate must still attempt reads inside its budget')
  assert.ok(
    seam.calls.length * SHADOW_GATE_THRESHOLDS.readTimeoutMs * READ_ATTEMPTS <=
      SHADOW_GATE_THRESHOLDS.overallDeadlineMs,
    'the gate read past its own deadline'
  )
  // A verdict, not a crash: a skipped read is an unverified check, which can never read as PASS.
  assert.equal(report.reportOnly, true)
  assert.equal(report.verdict, 'WARN')
  assert.equal(report.checks.cellServing.status, 'unverified')
  // No read is ever given more time than the budget still has left.
  for (const { options } of seam.calls) {
    assert.ok(options.timeoutMs > 0)
    assert.ok(options.timeoutMs <= SHADOW_GATE_THRESHOLDS.readTimeoutMs)
  }
})

test('the job runs the gate report-only, after verification, and uploads its artifact', () => {
  const workflow = readRelayWorkflow('deploy-relay-production-same-cap-job.yml')
  const gate = workflow.slice(workflow.indexOf('- name: Shadow health gate (report only)'))
  assert.notEqual(gate, '')
  // Two independent guarantees that no verdict can fail a cell: the step's own exit code and this.
  assert.match(gate.slice(0, gate.indexOf('run:')), /continue-on-error: true/)
  assert.match(gate, /relay-same-cap-shadow-gate\.mjs/)
  // The gate and its upload must be bounded in time as well as in outcome: a step that runs past
  // the job's timeout-minutes gets the job cancelled, and cancellation stops the whole wave.
  const gateHeader = gate.slice(0, gate.indexOf('run:'))
  assert.match(gateHeader, /timeout-minutes: (\d+)/)
  const stepTimeoutMinutes = Number(/timeout-minutes: (\d+)/.exec(gateHeader)[1])
  assert.equal(stepTimeoutMinutes, 8)
  // The script has to settle on its own before the runner kills it, or the artifact is never
  // written and the step reports nothing at all.
  assert.ok(
    SHADOW_GATE_THRESHOLDS.overallDeadlineMs < stepTimeoutMinutes * 60_000,
    'the gate deadline must leave the step time to write its verdict'
  )
  const upload = workflow.slice(workflow.indexOf('- name: Publish the shadow health gate verdict'))
  assert.match(upload.slice(0, upload.indexOf('uses:')), /timeout-minutes: 2/)
  assert.match(
    workflow,
    /name: relay-same-cap-shadow-gate-\$\{\{ inputs\.target-cell-id \}\}-\$\{\{ github\.run_id \}\}\.json/
  )
  // The gate is judged over the wave it just ran, so the job has to stamp its own steps, and the
  // stamps reach the script through the environment rather than being expanded into its shell.
  for (const [step, output] of [
    ['drain', 'drain-started-at'],
    ['drain', 'drain-settled-at'],
    ['apply', 'apply-started-at'],
    ['apply', 'apply-completed-at'],
    ['verify-target', 'verify-ended-at']
  ]) {
    // Scoped to the step that owns the stamp: a stamp written anywhere else in the job would
    // still satisfy a whole-file match while recording the wrong instant.
    assert.match(
      stepBody(workflow, STAMP_STEPS[step]),
      new RegExp(`${output}=\\$\\(date -u \\+%FT%TZ\\)`),
      `${output} must be stamped inside the ${step} step`
    )
    assert.match(gate, new RegExp(`\\$\\{\\{ steps\\.${step}\\.outputs\\.${output} \\}\\}`))
    assert.match(gate, new RegExp(`--${output} "\\$\\{[A-Z_]+\\}"`))
  }
  // Settled means restart-safe was proven, so the stamp follows that wait, not the drain call.
  const drainStep = stepBody(workflow, STAMP_STEPS.drain)
  assert.notEqual(drainStep.indexOf('--activity restart-safe'), -1)
  assert.ok(
    drainStep.indexOf('drain-settled-at=') > drainStep.indexOf('--activity restart-safe'),
    'drain-settled-at must be stamped after the restart-safe wait'
  )
  assert.match(drainStep, /drain-applied-pace-window-ms=\$\(jq -er '\.paceWindowMs' <<< "\$\{DRAIN_RESULT\}"\)/)
  for (const flag of ['drain-pace-window-ms', 'drain-applied-pace-window-ms', 'target-hosts']) {
    assert.match(gate, new RegExp(`--${flag} "\\$\\{[A-Z_]+(:-)?\\}"`), flag)
  }
  // The apply-start stamp has to precede the operation that can restart the instance, or the
  // listener it bounds the search by has already happened. Presence is asserted before order,
  // because indexOf answers -1 for an absent stamp and -1 precedes everything.
  const applyStep = stepBody(workflow, STAMP_STEPS.apply)
  const stampedAt = applyStep.indexOf('apply-started-at=')
  const appliedAt = applyStep.indexOf('terraform -chdir=infra/terraform apply')
  assert.notEqual(stampedAt, -1, 'the apply step does not stamp apply-started-at at all')
  assert.notEqual(appliedAt, -1, 'the apply step no longer runs terraform apply')
  assert.ok(stampedAt < appliedAt, 'apply-started-at must be stamped before terraform apply')
  // Verification has to have happened first, or the gate judges a cell nothing checked, and the
  // restore too, so reading logs never holds the cell out of admission for longer than today.
  for (const earlier of [
    '- name: Verify new incarnation, exact image, protocol, and durable safety',
    '- name: Restore only the verified selected cell to its entry admission'
  ]) {
    assert.ok(
      workflow.indexOf(earlier) < workflow.indexOf('- name: Shadow health gate (report only)'),
      earlier
    )
  }
})

// Director runtime-metrics samples: one per 30 s per instance, each counting the 30 s before it.
function directorSamples({ from, count, payload }) {
  return Array.from({ length: count }, (_, index) => ({
    matches: ['orca_relay_runtime_metrics', 'resource.type="cloud_run_revision"'],
    timestamp: new Date(Date.parse(from) + index * 30_000).toISOString(),
    payload
  }))
}

function director503s(minute, count) {
  return [{ minute503: minute, count }]
}

test('row-busy 503s are scheduled only up to the drain-return admissions they ride on', () => {
  const drain = drainReturnByMinute([{
    failed: false,
    samples: [{
      timestamp: '2026-10-05T20:01:00Z',
      drainReturnAssignmentsDelta: 10,
      assign503sByCauseDelta: { relay_assignment_row_busy: 8, 'placement-lane': 5 }
    }]
  }], 1000)
  assert.deepEqual(drain.ownRetriesPerMinute, { '2026-10-05T20:00': 8 })
  assert.equal(drain.rowBusyBeyondDrainTotal, 0)
  const split = withoutDrainDeferrals(
    { perMinute: { '2026-10-05T20:00': 13 } },
    drain,
    ['2026-10-05T20:00']
  )
  // The placement-lane refusals stay: only the row-busy ones were scheduled.
  assert.deepEqual(split.series, [5])
})

test('row-busy 503s beyond the drain stay in the non-drain budget and fail it', () => {
  const minutes = Array.from({ length: 10 }, (_, index) => `2026-10-05T20:0${index}`)
  // No drain in the background, and 3 drain-return admissions a minute in the window against 60
  // row-busy refusals: row contention the drain does not explain.
  const samples = minutes.map((minute, index) => ({
    timestamp: new Date(Date.parse(`${minute}:30Z`) + 30_000).toISOString(),
    drainReturnAssignmentsDelta: index < 5 ? 0 : 3,
    assign503sByCauseDelta: { relay_assignment_row_busy: index < 5 ? 0 : 60 }
  }))
  const drain = drainReturnByMinute([{ failed: false, samples }], 1000)
  assert.equal(drain.rowBusyBeyondDrainTotal, 5 * (60 - 3 - 2))
  const perMinute = Object.fromEntries(minutes.map((minute, index) => [minute, index < 5 ? 2 : 60]))
  const background = backgroundOf(withoutDrainDeferrals({ perMinute }, drain, minutes.slice(0, 5)))
  const observed = withoutDrainDeferrals({ perMinute }, drain, minutes.slice(5))
  assert.deepEqual(observed.series, [55, 55, 55, 55, 55])
  assert.equal(judgeNonDrain503Budget({ observed, background }).status, 'would-block')
})

test('scheduled 503s come out of the count, split across the minutes they cover', () => {
  const drain = drainReturnByMinute([{
    failed: false,
    samples: [
      // Counts 20:00:30-20:01:00, so all of it belongs to 20:00.
      { timestamp: '2026-10-05T20:01:00Z', drainReturnDeferralsDelta: 40, drainReturnAssignmentsDelta: 70 },
      // Counts 20:00:50-20:01:20: a third in 20:00, two thirds in 20:01.
      {
        timestamp: '2026-10-05T20:01:20Z',
        drainReturnDeferralsDelta: 30,
        drainReturnAssignmentsDelta: 90,
        drainReturnRetryAfterSecondsMax: 12,
        placementRejectionsByReasonDelta: { 'host-rate-limited': 6, 'wait-timeout': 50 },
        stickyRejectionsByReasonDelta: { 'host-in-flight': 3, 'queue-full': 9 }
      }
    ]
  }], 1000)
  assert.deepEqual(drain.deferralsPerMinute, { '2026-10-05T20:00': 50, '2026-10-05T20:01': 20 })
  // A host's own early retry is scheduled; a lane that timed out or was full is not.
  assert.deepEqual(drain.ownRetriesPerMinute, { '2026-10-05T20:00': 3, '2026-10-05T20:01': 6 })
  assert.equal(drain.assignmentsPeakPerMinute, 100)
  assert.equal(drain.retryAfterSecondsMax, 12)
  const minutes = ['2026-10-05T20:00', '2026-10-05T20:01', '2026-10-05T20:02']
  const split = withoutDrainDeferrals({
    perMinute: { '2026-10-05T20:00': 90, '2026-10-05T20:01': 20, '2026-10-05T20:02': 25 }
  }, drain, minutes)
  // A minute cannot go negative when more was scheduled than was counted.
  assert.deepEqual(split.series, [37, 0, 25])
  assert.equal(split.peak, 37)
  assert.equal(split.peakMinute, '2026-10-05T20:00')
  assert.equal(split.allPeak, 90)
  assert.equal(split.drainDeferralsTotal, 70)
  assert.equal(split.ownRetriesTotal, 9)
  assert.equal(split.unverified, false)
  // A failed count, or a metrics read that failed, hit its limit, or came back short of one
  // instance's samples, leaves the answer unverified: an empty answer is not a calm director.
  assert.equal(drainReturnByMinute([{ failed: true, samples: [] }], 1000).truncated, true)
  assert.equal(drainReturnByMinute([{ samples: [], minSamples: 20 }], 1000).truncated, true)
  assert.equal(drainReturnByMinute([{
    samples: Array.from({ length: 19 }, (_, index) => ({
      timestamp: new Date(Date.parse('2026-10-05T20:00:30Z') + index * 30_000).toISOString()
    })),
    minSamples: 20
  }], 1000).truncated, true)
  assert.equal(withoutDrainDeferrals({ perMinute: {}, failed: true }, drain, minutes).unverified, true)
  assert.equal(withoutDrainDeferrals(
    { perMinute: {} },
    { deferralsPerMinute: {}, truncated: true },
    minutes
  ).unverified, true)
})

test('the background is the median pre-drain minute, so one incident minute cannot move it', () => {
  const background = backgroundOf({
    minutes: Array.from({ length: 10 }, (_, index) => `2026-10-05T19:5${index}`),
    series: [2, 0, 1, 3, 900, 1, 0, 2, 4, 1],
    peak: 900,
    unverified: false
  })
  assert.equal(background.medianPerMinute, 1.5)
  assert.equal(backgroundOf({ minutes: [], series: [], peak: 0, unverified: false }).unverified, true)
})

test('the rung budget needs two straight minutes over its line, never one', () => {
  const judge = (series, medianPerMinute = 1.5, unverified = false) => judgeNonDrain503Budget({
    observed: { series, peak: Math.max(...series), unverified },
    background: { medianPerMinute, unverified: false }
  })
  const calm = judge([0, 3, 87, 1, 0, 39, 0, 22, 12])
  assert.equal(calm.peakPerMinute, 87)
  // 10-02 c16 and c21: single minutes at 87 and 39 are transients.
  assert.equal(calm.status, 'pass')
  assert.equal(calm.warnAbove, 21.5)
  assert.equal(calm.blockAbove, 41.5)
  assert.equal(judge([0, 25, 23, 0]).status, 'warn')
  // 10-01 c29: thousands a minute for nine minutes.
  assert.equal(judge([288, 2619, 4226, 5357, 6256, 6662]).status, 'would-block')
  assert.equal(judge([0, 42, 42, 0]).status, 'would-block')
  // One minute past max(10x, 200) blocks alone: a short herd is over before a second minute.
  const spike = judge([0, 201, 0])
  assert.equal(spike.spikeAbove, 200)
  assert.equal(spike.status, 'would-block')
  assert.equal(judge([0, 112, 0]).status, 'pass')
  // 10-01 00:30 c28: a brownout already under way lifts the median, and the sustained rule holds.
  assert.equal(judge([8136, 7000, 3000], 824).status, 'would-block')
  // A busy background lifts both lines by its multiple, not just the margin.
  const busy = judge([100, 100], 60)
  assert.equal(busy.warnAbove, 90)
  assert.equal(busy.blockAbove, 120)
  assert.equal(busy.status, 'warn')
  assert.equal(judge([0], 1.5, true).status, 'unverified')
})

test('a drain is judged on how long it tells hosts to wait, not on how many it defers', () => {
  const drain = (retryAfterSecondsMax, truncated = false) => ({
    deferralsTotal: 400,
    deferralsPeakPerMinute: 300,
    assignmentsTotal: 530,
    assignmentsPeakPerMinute: 260,
    retryAfterSecondsMax,
    truncated
  })
  assert.equal(judgeDrainDeferrals(drain(30)).status, 'pass')
  assert.equal(judgeDrainDeferrals(drain(31)).status, 'warn')
  assert.equal(judgeDrainDeferrals(drain(61)).status, 'would-block')
  assert.equal(judgeDrainDeferrals(drain(2, true)).status, 'unverified')
  assert.equal(judgeDrainDeferrals(drain(2)).replacementsPeakPerMinute, 260)
})

// A 30 s rung on a 530-host cell: hundreds of scheduled deferrals in two minutes, over a pre-drain
// background whose own 503s were ordinary. Counting the deferrals as failures would block every
// fast drain.
test('a fast drain\'s deferrals do not read as a brownout', async () => {
  const entries = [
    ...productionLikeEntries(),
    ...director503s('2026-09-20T19:52', 20),
    ...director503s('2026-09-20T19:55', 25),
    ...director503s('2026-09-20T20:00', 400),
    ...director503s('2026-09-20T20:01', 330),
    ...director503s('2026-09-20T20:05', 30),
    ...directorSamples({
      from: '2026-09-20T20:00:30Z',
      count: 4,
      payload: {
        drainReturnDeferralsDelta: 190,
        drainReturnAssignmentsDelta: 130,
        drainReturnRetryAfterSecondsMax: 14
      }
    })
  ]
  const seam = gcloudSeam(entries)
  const report = await evaluateShadowGate(
    parseShadowGateArguments(ARGV.with(19, '30000').with(21, '30000')),
    seam
  )
  // One count of every minute from ten before the drain to the end of the window, whole minutes.
  assert.equal(seam.monitoringCalls.length, 1)
  assert.equal(seam.monitoringCalls[0].query.get('interval.startTime'), '2026-09-20T19:50:00.000Z')
  assert.equal(seam.monitoringCalls[0].query.get('interval.endTime'), '2026-09-20T20:30:00.000Z')
  assert.match(seam.monitoringCalls[0].query.get('filter'), /run\.googleapis\.com\/request_count/)
  assert.match(seam.monitoringCalls[0].query.get('filter'), /"response_code"="503"/)
  assert.equal(seam.monitoringCalls[0].init.headers.authorization, 'Bearer token')
  assert.equal(report.background.minutes, 10)
  assert.equal(Math.max(...report.background.perMinute), 25)
  assert.equal(report.checks.nonDrain503Budget.allPeakPerMinute, 400)
  assert.equal(report.checks.nonDrain503Budget.drainDeferralsTotal, 760)
  assert.equal(report.checks.nonDrain503Budget.peakPerMinute, 30)
  assert.equal(report.checks.nonDrain503Budget.status, 'pass')
  assert.equal(report.checks.drainDeferrals.status, 'pass')
  assert.equal(report.checks.drainDeferrals.replacementsTotal, 520)
  assert.equal(report.drain.paceWindowMs, 30_000)
  assert.equal(report.paceVerdict, 'PASS')
  assert.equal(report.verdict, 'PASS')
  // The same 503s with no deferrals behind them are exactly what the gate exists to catch.
  const brownout = await evaluateShadowGate(
    parseShadowGateArguments(ARGV),
    gcloudSeam(entries.filter((entry) => !entry.payload?.drainReturnDeferralsDelta))
  )
  assert.equal(brownout.checks.nonDrain503Budget.status, 'would-block')
  assert.equal(brownout.paceVerdict, 'WOULD_BLOCK')
})

// The pace verdict is what a canary seals, so fleet noise the pace cannot cause must not reach it.
test('the pace verdict reads only the checks a drain pace can move', async () => {
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), gcloudSeam([
    ...productionLikeEntries(),
    { matches: ['FATAL'], timestamp: '2026-09-20T20:10:00Z' }
  ]))
  assert.equal(report.checks.cloudSqlFatal.status, 'warn')
  assert.equal(report.verdict, 'WARN')
  assert.equal(report.paceVerdict, 'PASS')
  assert.deepEqual(PACE_CHECKS, ['nonDrain503Budget', 'drainDeferrals'])
})

// Reproduced in final review: every read succeeds and returns nothing. That must not read as a calm
// drain, or it seals a canary PASS that authorizes a fast batch.
test('a gate whose reads all come back empty is unverified, never a pace PASS', async () => {
  const seam = {
    retryDelayMs: 0,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    runGcloud: async (args) => ({ stdout: args[0] === 'auth' ? 'token\n' : '[]' })
  }
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.checks.nonDrain503Budget.status, 'unverified')
  assert.equal(report.checks.drainDeferrals.status, 'unverified')
  assert.equal(report.paceVerdict, 'WARN')
})
