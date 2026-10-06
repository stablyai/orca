#!/usr/bin/env node
// Post-wave shadow health gate for a same-cap cell roll. Reads exactly the oracles an operator
// reads by hand today, writes a PASS / WARN / WOULD_BLOCK verdict with its numbers to a JSON
// artifact and the step summary, and always exits 0 on a verdict: this runs in report-only mode so
// its calls can be compared with the operator's over a full roll before it is allowed to block.
//
// Every filter is built from validated, pattern-pinned inputs and handed to gcloud as argv, never
// through a shell.

import { execFile } from 'node:child_process'
import { appendFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  BACKGROUND_MINUTES,
  DIRECTOR_METRICS_INTERVAL_MS,
  ENTRY_LIMIT,
  PACE_CHECKS,
  FLEET_POOL_CELL_IDS,
  SHADOW_GATE_THRESHOLDS,
  combineVerdict,
  countByMinute,
  drainReturnByMinute,
  formatTimestamp,
  backgroundOf,
  judgeCellServing,
  judgeCloudSqlFatal,
  judgeDrainDeferrals,
  judgeNonDrain503Budget,
  judgePool,
  minuteKey,
  minutesOf,
  parseTimestamp,
  renderStepSummary,
  resolveWindow,
  splitWindow,
  withoutDrainDeferrals
} from './relay-same-cap-shadow-gate-verdict.mjs'
import { SAME_CAP_DRAIN_PACE_WINDOWS_MS } from './relay-production-same-cap-wave.mjs'

const execFileAsync = promisify(execFile)

const CELL_ID = /^production-gce-c[1-9][0-9]*$/
const CELL_HOST = /^c[1-9][0-9]*\.relay\.onorca\.dev$/
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,62}$/
const COUNT = /^(0|[1-9][0-9]*)$/

export const READ_ATTEMPTS = 3
const READ_RETRY_DELAY_MS = 5000
const READ_TIMEOUT_MS = SHADOW_GATE_THRESHOLDS.readTimeoutMs
const OVERALL_DEADLINE_MS = SHADOW_GATE_THRESHOLDS.overallDeadlineMs
// json(timestamp) over a busy minute is a few hundred KB; leave room for the widest sub-window.
const READ_MAX_BUFFER_BYTES = 256 * 1024 * 1024

export function parseShadowGateArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--')) throw new Error(`expected a flag, got ${argv[index]}`)
    values.set(argv[index].slice(2), argv[index + 1])
  }
  const required = (name, pattern) => {
    const value = values.get(name) ?? ''
    if (!pattern.test(value)) throw new Error(`--${name} is not acceptable: ${value}`)
    return value
  }
  const optionalCount = (name) => (values.get(name) ? Number(required(name, COUNT)) : null)
  const config = {
    cellId: required('cell-id', CELL_ID),
    cellHost: required('cell-host', CELL_HOST),
    projectId: required('project-id', PROJECT_ID),
    directorService: required('director-service', SERVICE_NAME),
    drainStartedAt: values.get('drain-started-at') || '',
    // The listener lands while the MIG is still converging, so the boot search has to open at the
    // apply's start; a bound taken at its completion is already past the announcement it looks for.
    applyStartedAt: values.get('apply-started-at') || '',
    applyCompletedAt: values.get('apply-completed-at') || '',
    verifyEndedAt: values.get('verify-ended-at') || '',
    outputFile: values.get('output-file') || '',
    summaryFile: values.get('summary-file') || '',
    drainPaceWindowMs: Number(required('drain-pace-window-ms', COUNT)),
    // Empty on a resumed rollback, which never drains.
    drainAppliedPaceWindowMs: optionalCount('drain-applied-pace-window-ms'),
    drainSettledAt: values.get('drain-settled-at') || '',
    targetHosts: optionalCount('target-hosts')
  }
  if (!SAME_CAP_DRAIN_PACE_WINDOWS_MS.includes(config.drainPaceWindowMs)) {
    throw new Error(`--drain-pace-window-ms is not acceptable: ${config.drainPaceWindowMs}`)
  }
  if (config.drainSettledAt) parseTimestamp(config.drainSettledAt, '--drain-settled-at')
  if (!config.cellHost.startsWith(`${config.cellId.replace('production-gce-', '')}.`)) {
    throw new Error(`--cell-host ${config.cellHost} is not the host of ${config.cellId}`)
  }
  if (!config.outputFile) throw new Error('--output-file is required')
  return config
}

function timestampBounds({ startedAt, endedAt }) {
  return `timestamp>="${formatTimestamp(startedAt)}" AND timestamp<"${formatTimestamp(endedAt)}"`
}

/**
 * Runs one bounded read with retries. A read that cannot complete is reported as failed rather than
 * thrown: a missing oracle must surface as an unverified check, not as a crashed gate.
 */
async function retryingRead(reader, read) {
  let lastError
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    // Every remaining read short-circuits once the budget is gone, so the gate always reaches a
    // verdict instead of being killed part-way through with nothing written.
    const remainingMs = reader.deadlineAt - reader.now()
    if (remainingMs <= 0) return { failed: true, error: 'shadow gate read deadline exceeded' }
    try {
      return { ...(await read(Math.min(reader.readTimeoutMs, remainingMs))), failed: false }
    } catch (error) {
      lastError = error
      if (attempt < READ_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, reader.retryDelayMs))
      }
    }
  }
  return { failed: true, error: String(lastError?.message ?? lastError) }
}

async function readLogEntries(reader, { filter, projection, limit = ENTRY_LIMIT }) {
  const args = [
    'logging', 'read', filter,
    '--project', reader.projectId,
    '--format', projection,
    '--limit', String(limit),
    '--order', 'desc'
  ]
  const read = await retryingRead(reader, async (timeoutMs) => {
    const { stdout } = await reader.runGcloud(args, { timeoutMs })
    return { entries: JSON.parse(stdout || '[]') }
  })
  return { entries: [], ...read }
}

async function readTimestampsOverWindow(reader, { filter, window }) {
  const reads = []
  for (const subWindow of splitWindow(window)) {
    const read = await readLogEntries(reader, {
      filter: `${filter} AND ${timestampBounds(subWindow)}`,
      projection: 'json(timestamp)'
    })
    reads.push({
      failed: read.failed,
      timestamps: read.entries.map((entry) => entry.timestamp)
    })
  }
  return countByMinute(reads)
}

// Cloud Run's own request counter, aligned per minute server-side: a brownout's tens of thousands
// of 503s are counted, where a log read of them stops at its entry limit (10-01 c29).
async function readDirector503PerMinute(reader, { config, span }) {
  const url = new URL(`https://monitoring.googleapis.com/v3/projects/${config.projectId}/timeSeries`)
  url.searchParams.set('filter', [
    'metric.type="run.googleapis.com/request_count"',
    'resource.type="cloud_run_revision"',
    `resource.label."service_name"="${config.directorService}"`,
    'metric.label."response_code"="503"'
  ].join(' AND '))
  url.searchParams.set('interval.startTime', span.startedAt.toISOString())
  url.searchParams.set('interval.endTime', span.endedAt.toISOString())
  url.searchParams.set('aggregation.alignmentPeriod', '60s')
  url.searchParams.set('aggregation.perSeriesAligner', 'ALIGN_DELTA')
  url.searchParams.set('aggregation.crossSeriesReducer', 'REDUCE_SUM')
  url.searchParams.set('pageSize', '1000')
  const read = await retryingRead(reader, async (timeoutMs) => {
    const { stdout } = await reader.runGcloud(['auth', 'print-access-token'], { timeoutMs })
    const response = await reader.fetch(url, {
      headers: { authorization: `Bearer ${stdout.trim()}` },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) throw new Error(`Cloud Monitoring returned ${response.status}`)
    const body = await response.json()
    if (body.nextPageToken) throw new Error('Cloud Monitoring pagination is incomplete')
    return { timeSeries: body.timeSeries ?? [] }
  })
  const perMinute = {}
  for (const series of read.timeSeries ?? []) {
    for (const point of series.points ?? []) {
      // A delta point covers the minute that ends at its end time; a minute with no point had none.
      const minute = minuteKey(Date.parse(point.interval.endTime) - 60_000)
      perMinute[minute] = (perMinute[minute] ?? 0) + Number(point.value.int64Value ?? 0)
    }
  }
  return { perMinute, failed: read.failed }
}

// Cells log through the COS container agent, so the text lives in jsonPayload.message; a
// textPayload filter matches nothing here and returns zero without saying so.
const CELL_LOG_SCOPE = 'resource.type="gce_instance" AND logName:"cos_containers"'

const DIRECTOR_DRAIN_FIELDS = [
  'stickyRejectionsByReasonDelta',
  'placementRejectionsByReasonDelta',
  'drainReturnDeferralsDelta',
  'drainReturnAssignmentsDelta',
  'drainReturnRetryAfterSecondsMax'
]

// Five instances at one sample per 30 s is ~100 per 10-min sub-window; this many is truncation.
const DIRECTOR_METRICS_LIMIT = 1000

async function readDirectorDrainReturn(reader, { config, window }) {
  const projection = `json(timestamp,${DIRECTOR_DRAIN_FIELDS
    .map((field) => `jsonPayload.${field}`)
    .join(',')})`
  const reads = []
  for (const subWindow of splitWindow(window)) {
    const read = await readLogEntries(reader, {
      filter: `resource.type="cloud_run_revision"`
        + ` AND resource.labels.service_name="${config.directorService}"`
        + ` AND jsonPayload.event="orca_relay_runtime_metrics"`
        + ` AND ${timestampBounds(subWindow)}`,
      projection,
      limit: DIRECTOR_METRICS_LIMIT
    })
    reads.push({
      failed: read.failed,
      samples: read.entries.map((entry) => ({ timestamp: entry.timestamp, ...entry.jsonPayload })),
      minSamples: Math.floor(
        (subWindow.endedAt.getTime() - subWindow.startedAt.getTime()) / DIRECTOR_METRICS_INTERVAL_MS
      )
    })
  }
  return reads
}

// Non-drain 503s in the roll window against the same day's minutes just before the drain, with
// drain-return deferrals taken out of both.
async function readDirector503(reader, { config, window }) {
  const minute = 60_000
  const span = {
    startedAt: new Date(
      Math.floor(window.startedAt.getTime() / minute) * minute - BACKGROUND_MINUTES * minute
    ),
    endedAt: new Date(Math.ceil(window.endedAt.getTime() / minute) * minute)
  }
  const counts = await readDirector503PerMinute(reader, { config, span })
  const reads = await readDirectorDrainReturn(reader, { config, window: span })
  const deferrals = drainReturnByMinute(reads, DIRECTOR_METRICS_LIMIT)
  const windowMinutes = minutesOf(window)
  const backgroundMinutes = minutesOf({ startedAt: span.startedAt, endedAt: window.startedAt })
    .filter((key) => !windowMinutes.includes(key))
  const observed = withoutDrainDeferrals(counts, deferrals, windowMinutes)
  const background = backgroundOf(withoutDrainDeferrals(counts, deferrals, backgroundMinutes))
  // Only the roll window's own samples describe this drain; whether the reads were whole is a
  // question about all of them.
  const drain = {
    ...drainReturnByMinute(reads.map((read) => ({
      failed: read.failed,
      samples: read.samples.filter(
        (sample) => Date.parse(sample.timestamp) > window.startedAt.getTime()
      )
    })), DIRECTOR_METRICS_LIMIT),
    truncated: deferrals.truncated
  }
  return {
    background,
    checks: {
      nonDrain503Budget: judgeNonDrain503Budget({ observed, background }),
      drainDeferrals: judgeDrainDeferrals(drain)
    }
  }
}

/**
 * The cell's new container. The listener announcement after the apply identifies both that the
 * cell is serving and which instance it is serving on; crashes are then scoped to that instance,
 * because instance_id is stable across a container restart and is the only cell label these
 * entries carry.
 */
async function readCellServing(reader, { config, window, searchFrom, expectBoot }) {
  const listening = await readLogEntries(reader, {
    filter: `${CELL_LOG_SCOPE}`
      + ` AND jsonPayload.message:"listening on https://${config.cellHost}"`
      + ` AND ${timestampBounds({ startedAt: searchFrom, endedAt: window.endedAt })}`,
    projection: 'json(timestamp,resource.labels.instance_id)',
    limit: 50
  })
  // Newest first: the most recent announcement is the boot this wave produced.
  const boot = listening.entries[0]
  if (listening.failed || !boot) {
    return {
      serving: judgeCellServing({ listeningAt: null, read: listening, expectBoot }),
      instanceId: null
    }
  }
  const crashes = await readLogEntries(reader, {
    filter: `${CELL_LOG_SCOPE}`
      + ` AND jsonPayload.message:"throw er"`
      + ` AND resource.labels.instance_id="${boot.resource.labels.instance_id}"`
      + ` AND ${timestampBounds({ startedAt: searchFrom, endedAt: window.endedAt })}`,
    projection: 'json(timestamp)',
    limit: 100
  })
  return {
    serving: judgeCellServing({
      listeningAt: boot.timestamp,
      crashesSinceApply: crashes.entries.length,
      read: crashes,
      expectBoot
    }),
    instanceId: boot.resource.labels.instance_id
  }
}

const RUNTIME_METRIC_FIELDS = [
  'totalConnections',
  'databasePoolWaitersMax',
  'databasePoolWaiting',
  'sqlFailuresDelta',
  'reconnectsDelta'
]

async function readRuntimeMetrics(reader, { cellId, window }) {
  const projection = `json(timestamp,${RUNTIME_METRIC_FIELDS
    .map((field) => `jsonPayload.${field}`)
    .join(',')})`
  const samples = []
  let failed = false
  let truncated = false
  // Samples land every 30 s, so a 10-minute sub-window holds ~20. A read that comes back at this
  // many is not a calm sub-window, it is a truncated one, and its gaps read as recoveries.
  const limit = 500
  for (const subWindow of splitWindow(window)) {
    const read = await readLogEntries(reader, {
      filter: `${CELL_LOG_SCOPE}`
        + ` AND jsonPayload.event="orca_relay_runtime_metrics"`
        + ` AND jsonPayload.cellId="${cellId}"`
        + ` AND ${timestampBounds(subWindow)}`,
      projection,
      limit
    })
    if (read.failed) failed = true
    if (read.entries.length >= limit) truncated = true
    for (const entry of read.entries) {
      samples.push({ timestamp: entry.timestamp, ...entry.jsonPayload })
    }
  }
  return { samples, failed, truncated }
}

async function readCloudSqlFatal(reader, { window }) {
  const counts = await readTimestampsOverWindow(reader, {
    filter: `resource.type="cloudsql_database" AND "FATAL"`,
    window
  })
  return judgeCloudSqlFatal({ count: counts.total, truncated: counts.truncated })
}

export async function evaluateShadowGate(config, {
  runGcloud,
  retryDelayMs = READ_RETRY_DELAY_MS,
  readTimeoutMs = READ_TIMEOUT_MS,
  overallDeadlineMs = OVERALL_DEADLINE_MS,
  now = Date.now,
  fetch = globalThis.fetch
}) {
  const reader = {
    runGcloud,
    retryDelayMs,
    readTimeoutMs,
    now,
    deadlineAt: now() + overallDeadlineMs,
    projectId: config.projectId,
    fetch
  }
  const window = resolveWindow(config)
  // Everything this roll's instance logged, from the moment the apply could first restart it.
  const searchFrom = config.applyStartedAt
    ? new Date(Date.parse(config.applyStartedAt))
    : window.startedAt
  // Serialised on purpose: a burst of concurrent reads is what earns a Logging 429, and a 429 is
  // the one failure that comes back as a short answer rather than an error.
  const director = await readDirector503(reader, { config, window })
  // A fallback window start means neither the drain nor the apply ran, which is the resumed
  // rollback that restarts nothing; there is then no boot to find.
  const cell = await readCellServing(reader, {
    config,
    window,
    searchFrom,
    expectBoot: window.startedFrom !== 'fallback'
  })
  const cloudSql = await readCloudSqlFatal(reader, { window })
  const cellMetrics = await readRuntimeMetrics(reader, { cellId: config.cellId, window })
  const checks = {
    ...director.checks,
    cellServing: cell.serving,
    cellPool: judgePool({ label: config.cellId, ...cellMetrics }),
    cloudSqlFatal: cloudSql
  }
  for (const fleetCellId of FLEET_POOL_CELL_IDS) {
    if (fleetCellId === config.cellId) continue
    const metrics = await readRuntimeMetrics(reader, { cellId: fleetCellId, window })
    checks[`fleetPool:${fleetCellId}`] = judgePool({ label: fleetCellId, ...metrics })
  }
  return {
    reportOnly: true,
    cellId: config.cellId,
    cellHost: config.cellHost,
    cellInstanceId: cell.instanceId,
    window: {
      startedAt: formatTimestamp(window.startedAt),
      endedAt: formatTimestamp(window.endedAt),
      startedFrom: window.startedFrom,
      // Recorded, not judged: an operator comparing verdicts needs to see how long the apply took
      // next to when the cell actually came back.
      applyCompletedAt: config.applyCompletedAt || null
    },
    // The ladder rung this roll ran at, and what it measured against, for the step's record.
    drain: {
      paceWindowMs: config.drainPaceWindowMs,
      appliedPaceWindowMs: config.drainAppliedPaceWindowMs,
      targetHosts: config.targetHosts,
      settledAt: config.drainSettledAt || null,
      // Isolate to restart-safe, which includes the quiet the restart wait holds after the cell
      // empties: (ceil(pace / 5 s) + 1) samples of 5 s.
      settledAfterSeconds: config.drainStartedAt && config.drainSettledAt
        ? Math.round((Date.parse(config.drainSettledAt) - Date.parse(config.drainStartedAt)) / 1000)
        : null
    },
    // The pre-drain minutes the 503 checks were judged against.
    background: director.background,
    verdict: combineVerdict(checks),
    // What a canary seals and a faster batch requires: only the checks the pace can move.
    paceVerdict: combineVerdict(Object.fromEntries(PACE_CHECKS.map((name) => [name, checks[name]]))),
    checks
  }
}

async function main() {
  const config = parseShadowGateArguments(process.argv.slice(2))
  const report = await evaluateShadowGate(config, {
    // `timeout` makes Node kill the child itself; continue-on-error bounds the job's outcome but
    // not its clock, and a stalled read would otherwise spend the rollout's remaining minutes.
    runGcloud: (args, { timeoutMs }) => execFileAsync('gcloud', args, {
      maxBuffer: READ_MAX_BUFFER_BYTES,
      timeout: timeoutMs,
      killSignal: 'SIGKILL'
    })
  })
  await writeFile(config.outputFile, `${JSON.stringify(report, null, 2)}\n`)
  if (config.summaryFile) await appendFile(config.summaryFile, renderStepSummary(report))
  console.log(JSON.stringify(report, null, 2))
}

// Report only: a verdict, including WOULD_BLOCK, is a successful run. Only a crash exits non-zero,
// and the job still runs this step under continue-on-error.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
