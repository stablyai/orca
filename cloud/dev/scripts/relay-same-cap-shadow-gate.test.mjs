import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readRelayWorkflow } from './relay-repository.mjs'
import {
  evaluateShadowGate,
  parseShadowGateArguments
} from './relay-same-cap-shadow-gate.mjs'
import {
  ENTRY_LIMIT,
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
  '--apply-completed-at', '2026-09-20T20:17:00Z',
  '--verify-ended-at', '2026-09-20T20:30:00Z',
  '--output-file', '/tmp/shadow.json'
]

function minuteOfTimestamps(minute, count) {
  return Array.from({ length: count }, (_, index) => `${minute}:${String(index % 60).padStart(2, '0')}Z`)
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
  assert.throws(() => parseShadowGateArguments(ARGV.slice(0, 14)))
})

test('the window runs from drain start to verify end, with named fallbacks', () => {
  const full = resolveWindow({
    drainStartedAt: '2026-09-20T20:00:00Z',
    applyCompletedAt: '2026-09-20T20:17:00Z',
    verifyEndedAt: '2026-09-20T20:30:00Z'
  })
  assert.equal(formatTimestamp(full.startedAt), '2026-09-20T20:00:00Z')
  assert.equal(full.startedFrom, 'drain')
  // A resumed rollback never drains, so the apply stands in for the start.
  assert.equal(resolveWindow({
    applyCompletedAt: '2026-09-20T20:17:00Z',
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
  const truncated = countByMinute([{ timestamps: minuteOfTimestamps('2026-09-19T15:34', ENTRY_LIMIT) }])
  assert.equal(truncated.truncated, true)
  const failed = countByMinute([{ failed: true, timestamps: [] }])
  assert.equal(failed.truncated, true)
  const counted = countByMinute([
    { timestamps: minuteOfTimestamps('2026-09-19T15:34', 4722) },
    { timestamps: minuteOfTimestamps('2026-09-19T15:33', 278) }
  ])
  assert.deepEqual(
    { peak: counted.peak, peakMinute: counted.peakMinute, total: counted.total, truncated: counted.truncated },
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

test('the cell has to announce its listener after the apply and stay up', () => {
  assert.equal(judgeCellServing({
    listeningAt: '2026-09-20T20:18:27Z',
    crashesAfterBoot: 0
  }).status, 'pass')
  assert.equal(judgeCellServing({ listeningAt: null }).status, 'would-block')
  // A resumed rollback restarts nothing, so there is no boot to find and silence proves nothing.
  assert.equal(judgeCellServing({ listeningAt: null, expectBoot: false }).status, 'unverified')
  assert.equal(judgeCellServing({
    listeningAt: '2026-09-20T20:18:27Z',
    crashesAfterBoot: 1
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
    samples: [{ databasePoolWaitersMax: 12 }, { databasePoolWaitersMax: 71 }, { databasePoolWaitersMax: 9 }]
  })
  assert.equal(burst.status, 'warn')
  assert.equal(burst.consecutiveSamplesOverWaitersThreshold, 1)
  assert.equal(judgePool({
    label: 'production-gce-c28',
    samples: [{ databasePoolWaitersMax: 148 }, { databasePoolWaitersMax: 125 }, { databasePoolWaitersMax: 154 }]
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

// The gcloud seam, driven by the exact entry shapes production returned for the c28 roll on
// 2026-09-20: the crash at 20:18:10Z and the listener at 20:18:27Z on instance 5031087219978409220.
function productionLikeGcloud(overrides = {}) {
  const calls = []
  return {
    calls,
    retryDelayMs: 0,
    runGcloud: async (args) => {
      const filter = args[2]
      calls.push(filter)
      for (const [needle, entries] of Object.entries(overrides)) {
        if (filter.includes(needle)) return { stdout: JSON.stringify(entries) }
      }
      if (filter.includes('listening on https://c28.relay.onorca.dev')) {
        return {
          stdout: JSON.stringify([
            { timestamp: '2026-09-20T20:18:27.470301969Z', resource: { labels: { instance_id: '5031087219978409220' } } }
          ])
        }
      }
      if (filter.includes('throw er')) return { stdout: '[]' }
      if (filter.includes('orca_relay_runtime_metrics')) {
        return {
          stdout: JSON.stringify([{
            timestamp: '2026-09-20T20:25:57Z',
            jsonPayload: {
              totalConnections: 857,
              databasePoolWaitersMax: 4,
              databasePoolWaiting: 1,
              sqlFailuresDelta: 0,
              reconnectsDelta: 0
            }
          }])
        }
      }
      return { stdout: '[]' }
    }
  }
}

test('a healthy roll reads as PASS and names the instance it proved serving', async () => {
  const seam = productionLikeGcloud()
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.reportOnly, true)
  assert.equal(report.cellInstanceId, '5031087219978409220')
  assert.equal(report.window.startedFrom, 'drain')
  assert.deepEqual(Object.keys(report.checks).sort(), [
    'cellPool',
    'cellServing',
    'cloudSqlFatal',
    'director503',
    'fleetPool:production-gce-c27',
    'fleetPool:production-gce-c29'
  ])
  // Every read carries explicit bounds: --freshness does not bind on these logs.
  for (const filter of seam.calls) assert.match(filter, /timestamp>="[^"]+" AND timestamp<"[^"]+"/)
  // Cell text lives in jsonPayload.message; a textPayload filter matches nothing and says so.
  assert.equal(seam.calls.some((filter) => filter.includes('textPayload')), false)
  assert.match(renderStepSummary(report), /Shadow health gate \(report only\): PASS/)
})

test('a crash after the new boot reads as WOULD_BLOCK without failing the run', async () => {
  const seam = productionLikeGcloud({
    'throw er': [{ timestamp: '2026-09-20T20:18:10.651702662Z' }]
  })
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.verdict, 'WOULD_BLOCK')
  assert.equal(report.checks.cellServing.crashesAfterBoot, 1)
  // Crashes are scoped by instance_id, the only cell label these entries carry.
  assert.ok(seam.calls.some((filter) => filter.includes('resource.labels.instance_id="5031087219978409220"')))
})

test('a resume, which restarts nothing, does not read a missing boot as a failure', async () => {
  const resumed = ARGV.with(9, '').with(11, '')
  const report = await evaluateShadowGate(parseShadowGateArguments(resumed), {
    ...productionLikeGcloud({ 'listening on https://c28.relay.onorca.dev': [] })
  })
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

test('the job runs the gate report-only, after verification, and uploads its artifact', () => {
  const workflow = readRelayWorkflow('deploy-relay-production-same-cap-job.yml')
  const gate = workflow.slice(workflow.indexOf('- name: Shadow health gate (report only)'))
  assert.notEqual(gate, '')
  // Two independent guarantees that no verdict can fail a cell: the step's own exit code and this.
  assert.match(gate.slice(0, gate.indexOf('run:')), /continue-on-error: true/)
  assert.match(gate, /relay-same-cap-shadow-gate\.mjs/)
  assert.match(
    workflow,
    /name: relay-same-cap-shadow-gate-\$\{\{ inputs\.target-cell-id \}\}-\$\{\{ github\.run_id \}\}\.json/
  )
  // The gate is judged over the wave it just ran, so the job has to stamp its own steps, and the
  // stamps reach the script through the environment rather than being expanded into its shell.
  for (const [step, output] of [
    ['drain', 'drain-started-at'],
    ['apply', 'apply-completed-at'],
    ['verify-target', 'verify-ended-at']
  ]) {
    assert.match(workflow, new RegExp(`${output}=\\$\\(date -u \\+%FT%TZ\\)`))
    assert.match(gate, new RegExp(`\\$\\{\\{ steps\\.${step}\\.outputs\\.${output} \\}\\}`))
    assert.match(gate, new RegExp(`--${output} "\\$\\{[A-Z_]+\\}"`))
  }
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
