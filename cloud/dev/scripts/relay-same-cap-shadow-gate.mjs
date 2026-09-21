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
  BASELINE_OFFSET_HOURS,
  ENTRY_LIMIT,
  FLEET_POOL_CELL_IDS,
  SHADOW_GATE_THRESHOLDS,
  combineVerdict,
  countByMinute,
  formatTimestamp,
  judgeCellServing,
  judgeCloudSqlFatal,
  judgeDirector503,
  judgePool,
  renderStepSummary,
  resolveWindow,
  shiftWindow,
  splitWindow
} from './relay-same-cap-shadow-gate-verdict.mjs'

const execFileAsync = promisify(execFile)

const CELL_ID = /^production-gce-c[1-9][0-9]*$/
const CELL_HOST = /^c[1-9][0-9]*\.relay\.onorca\.dev$/
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,62}$/

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
    summaryFile: values.get('summary-file') || ''
  }
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
 * One bounded `gcloud logging read`. A read that cannot complete is reported as failed rather than
 * thrown: a missing oracle must surface as an unverified check, not as a crashed gate.
 */
async function readLogEntries(reader, { filter, projection, limit = ENTRY_LIMIT }) {
  const args = [
    'logging', 'read', filter,
    '--project', reader.projectId,
    '--format', projection,
    '--limit', String(limit),
    '--order', 'desc'
  ]
  let lastError
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    // Every remaining read short-circuits once the budget is gone, so the gate always reaches a
    // verdict instead of being killed part-way through with nothing written.
    const remainingMs = reader.deadlineAt - reader.now()
    if (remainingMs <= 0) {
      return { entries: [], failed: true, error: 'shadow gate read deadline exceeded' }
    }
    try {
      const timeoutMs = Math.min(reader.readTimeoutMs, remainingMs)
      const { stdout } = await reader.runGcloud(args, { timeoutMs })
      return { entries: JSON.parse(stdout || '[]'), failed: false }
    } catch (error) {
      lastError = error
      if (attempt < READ_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, reader.retryDelayMs))
      }
    }
  }
  return { entries: [], failed: true, error: String(lastError?.message ?? lastError) }
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

function directorFilter({ directorService }) {
  return `resource.type="cloud_run_revision"`
    + ` AND resource.labels.service_name="${directorService}"`
    + ` AND httpRequest.status=503`
}

// Cells log through the COS container agent, so the text lives in jsonPayload.message; a
// textPayload filter matches nothing here and returns zero without saying so.
const CELL_LOG_SCOPE = 'resource.type="gce_instance" AND logName:"cos_containers"'

async function readDirector503(reader, { config, window }) {
  const filter = directorFilter(config)
  const observed = await readTimestampsOverWindow(reader, { filter, window })
  const baselines = []
  for (const hours of BASELINE_OFFSET_HOURS) {
    const counts = await readTimestampsOverWindow(reader, {
      filter,
      window: shiftWindow(window, hours)
    })
    baselines.push({ label: `${hours}h-earlier`, ...counts })
  }
  return judgeDirector503({ observed, baselines })
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
  now = Date.now
}) {
  const reader = {
    runGcloud,
    retryDelayMs,
    readTimeoutMs,
    now,
    deadlineAt: now() + overallDeadlineMs,
    projectId: config.projectId
  }
  const window = resolveWindow(config)
  // Everything this roll's instance logged, from the moment the apply could first restart it.
  const searchFrom = config.applyStartedAt
    ? new Date(Date.parse(config.applyStartedAt))
    : window.startedAt
  // Serialised on purpose: a burst of concurrent reads is what earns a Logging 429, and a 429 is
  // the one failure that comes back as a short answer rather than an error.
  const director503 = await readDirector503(reader, { config, window })
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
    director503,
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
    verdict: combineVerdict(checks),
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
