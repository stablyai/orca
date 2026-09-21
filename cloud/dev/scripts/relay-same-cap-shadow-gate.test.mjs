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
  SHADOW_GATE_THRESHOLDS,
  SUB_WINDOW_MINUTES,
  combineVerdict,
  countByMinute,
  formatTimestamp,
  judgeCellServing,
  judgeCloudSqlFatal,
  judgeDirector503,
  judgePool,
  longestRunAtOrAbove,
  renderStepSummary,
  resolveWindow,
  shiftWindow,
  splitWindow
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
  '--output-file', '/tmp/shadow.json'
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
  assert.throws(() => parseShadowGateArguments(ARGV.slice(0, 16)))
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
  const baseline = shiftWindow(windows[0], 24)
  assert.equal(formatTimestamp(baseline.startedAt), '2026-09-19T20:00:00Z')
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

test('director 503s are judged against the busier baseline, not a fixed rate', () => {
  const baselines = [
    { label: '24h-earlier', peak: 48, total: 80, truncated: false },
    { label: '48h-earlier', peak: 69, total: 100, truncated: false }
  ]
  // The 2026-09-19 c28 wave: 4722/min against 48 and 69/min baselines.
  assert.equal(judgeDirector503({
    observed: { peak: 4722, peakMinute: '2026-09-19T15:34', total: 5000, truncated: false },
    baselines
  }).status, 'would-block')
  // The false positive a literal rule produced: a US ramp at 71/min over a 20-60/min baseline.
  assert.equal(judgeDirector503({
    observed: { peak: 71, peakMinute: '2026-09-18T01:10', total: 300, truncated: false },
    baselines: [
      { label: '24h-earlier', peak: 60, total: 400, truncated: false },
      { label: '48h-earlier', peak: 20, total: 90, truncated: false }
    ]
  }).status, 'pass')
  // A truncated read cannot settle to pass, however calm its visible counts are.
  assert.equal(judgeDirector503({
    observed: { peak: 3, total: 3, truncated: true },
    baselines
  }).status, 'unverified')
  assert.equal(judgeDirector503({
    observed: { peak: 3, total: 3, truncated: false },
    baselines: [baselines[0], { ...baselines[1], truncated: true }]
  }).status, 'unverified')
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
})

test('Cloud SQL FATALs warn from the first one and block on a run of them', () => {
  assert.equal(judgeCloudSqlFatal({ count: 0 }).status, 'pass')
  assert.equal(judgeCloudSqlFatal({ count: 1 }).status, 'warn')
  assert.equal(judgeCloudSqlFatal({ count: 21 }).status, 'would-block')
  assert.equal(judgeCloudSqlFatal({ count: 0, truncated: true }).status, 'unverified')
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
    ...metricSamples({ cellId: 'production-gce-c29', from: '2026-09-20T20:20:00Z', count: 20 })
  ]
}

/**
 * A gcloud seam that honours the filter it is given: its timestamp bounds, its instance-id scope,
 * the `--limit`, and the newest-first order. A fake that ignored the bounds would let a
 * wrongly-bounded query pass, which is exactly the bug class these tests exist to catch.
 */
function gcloudSeam(entries = productionLikeEntries()) {
  const calls = []
  return {
    calls,
    retryDelayMs: 0,
    runGcloud: async (args, options) => {
      const filter = args[2]
      const limit = Number(args[args.indexOf('--limit') + 1])
      calls.push({ filter, limit, options })
      const startedAt = Date.parse(/timestamp>="([^"]+)"/.exec(filter)[1])
      const endedAt = Date.parse(/timestamp<"([^"]+)"/.exec(filter)[1])
      const instanceId = /resource\.labels\.instance_id="([^"]+)"/.exec(filter)?.[1]
      const matched = entries.filter((entry) => {
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
    'director503',
    'fleetPool:production-gce-c27',
    'fleetPool:production-gce-c29'
  ])
  // Every read carries explicit bounds: --freshness does not bind on these logs.
  for (const { filter } of seam.calls) {
    assert.match(filter, /timestamp>="[^"]+" AND timestamp<"[^"]+"/)
  }
  // Cell text lives in jsonPayload.message; a textPayload filter matches nothing and says so.
  assert.equal(seam.calls.some(({ filter }) => filter.includes('textPayload')), false)
  assert.match(renderStepSummary(report), /Shadow health gate \(report only\): PASS/)
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
  assert.equal(report.checks.director503.status, 'unverified')
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
  assert.equal(timedOut.checks.director503.status, 'unverified')
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
