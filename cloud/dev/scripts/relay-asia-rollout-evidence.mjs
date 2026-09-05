import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readCloudSqlBackends } from './relay-asia-cloud-sql-metrics.mjs'
import { RELAY_GITHUB_REPOSITORY, relayWorkflowPath } from './relay-repository.mjs'

const REPOSITORY = RELAY_GITHUB_REPOSITORY
const ADMISSION_WORKFLOW = relayWorkflowPath('operate-relay-asia-admission.yml')
const STAGING_WORKFLOW = relayWorkflowPath('prove-relay-asia-staging.yml')
const STAGING_CELL = 'staging-gce-c4'
const C27 = 'production-gce-c27'
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
const SHA_PATTERN = /^[a-f0-9]{40}$/
const MAX_LOG_EDGE_GAP_MS = 120_000
const MAX_LOG_SAMPLE_GAP_MS = 120_000
const CLOUD_SQL_LIMIT = 320
const C27_CANARY_MINIMUM_MS = 5 * 60_000
const GENERATOR_CPU_PERCENT_LIMIT = 80
const GENERATOR_EVENT_LOOP_P99_MS_LIMIT = 100
const GENERATOR_RSS_GROWTH_MIB_LIMIT = 512
const DATABASE_POOL_TRANSIENT_WAITERS_MAX = 4
const DATABASE_POOL_TRANSIENT_WAIT_MS_MAX = 50

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function positiveInteger(value, label) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} is invalid`)
  return number
}

function instant(value, label) {
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) throw new Error(`${label} is invalid`)
  return date
}

function exactCells(actual, expected) {
  return Array.isArray(actual) &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
}

function source(input, environment, workflow) {
  if (input.repository !== REPOSITORY) throw new Error('repository is invalid')
  if (!SHA_PATTERN.test(input.commitSha)) throw new Error('commit SHA is invalid')
  return {
    repository: input.repository,
    workflow,
    environment,
    runId: positiveInteger(input.runId, 'run ID'),
    runAttempt: positiveInteger(input.runAttempt, 'run attempt'),
    commitSha: input.commitSha
  }
}

function baseEvidence(input, environment, cells, workflow = ADMISSION_WORKFLOW) {
  if (!DIGEST_PATTERN.test(input.imageDigest)) throw new Error('image digest is invalid')
  return {
    version: 1,
    source: source(input, environment, workflow),
    imageDigest: input.imageDigest,
    topology: {
      cellIds: cells,
      selectorGeneration: positiveInteger(input.selectorGeneration, 'selector generation')
    }
  }
}

export function buildStagingEvidence(input) {
  const start = instant(input.startedAt, 'staging proof start')
  const end = instant(input.endedAt, 'staging proof end')
  const launch = loadReports(input.launchReport, 'launch load report')
  const expectedLoad = {
    controls: 20, splices: 20, slowReaders: 4, wedgedReaders: 1,
    minimumSeconds: 210
  }
  assertLoadReports(launch, expectedLoad)
  const metrics = runtimeMetrics(input.logs, start, end, STAGING_CELL)
  assertPassingRuntimeMetrics(metrics, 'staging proof', 1)
  const minimumConcurrentSplices = expectedLoad.splices - expectedLoad.wedgedReaders
  if (
    metrics.targetControlsMax < expectedLoad.controls ||
    metrics.targetSplicesMax < minimumConcurrentSplices
  ) {
    throw new Error('staging launch load did not reach C4 at the reviewed levels')
  }
  metrics.cloudSqlBackendsMax = cloudSqlMaximum(input.cloudSql, start, end)
  if (metrics.cloudSqlBackendsMax >= CLOUD_SQL_LIMIT) {
    throw new Error(`Cloud SQL backends must remain below ${CLOUD_SQL_LIMIT}`)
  }
  return {
    ...baseEvidence(input, 'staging', [STAGING_CELL], STAGING_WORKFLOW),
    kind: 'staging-asia-readiness',
    window: { startedAt: start.toISOString(), endedAt: end.toISOString() },
    load: { launch: loadSummary(launch) },
    metrics
  }
}

function loadReports(value, label) {
  if (!Array.isArray(value) || value.length < 2) throw new Error(`${label} must be sharded`)
  return value.map((report) => object(report, label))
}

function total(reports, key) {
  return reports.reduce((sum, report) => sum + number(report[key], key), 0)
}

function loadSummary(reports) {
  return {
    shards: reports.length,
    controls: total(reports, 'controls'),
    peakActive: total(reports, 'peakActive'),
    steadyMinimumActive: total(reports, 'steadyMinimumActive'),
    peakActiveSplices: total(reports, 'peakActiveSplices'),
    completedSplices: total(reports, 'completedSplices'),
    slowReaderSplicesCompleted: total(reports, 'slowReaderSplicesCompleted'),
    wedgedReaderSplicesClosed: total(reports, 'wedgedReaderSplicesClosed'),
    regionalFallbacksProved: total(reports, 'regionalFallbacksProved'),
    oldClientUsFirstProved: total(reports, 'oldClientUsFirstProved'),
    stickyAssignmentProved: total(reports, 'stickyAssignmentProved'),
    requestUnitInvitesOpened: total(reports, 'requestUnitInvitesOpened'),
    requestUnitPrincipalCounts: reports.map((report) => report.requestUnitPrincipalCount),
    requestUnitOverflowReasons:
      reports.map((report) => report.requestUnitOverflowReason).filter(Boolean),
    requestUnitCleanupProved: total(reports, 'requestUnitCleanupProved'),
    phaseBarrierPassed: reports.every((report) => report.phaseBarrierPassed === true),
    rebindProbesOpened: total(reports, 'rebindProbesOpened'),
    rebindOverflowReasons: reports.map((report) => report.rebindOverflowReason).filter(Boolean),
    readerQueueEvidence: reports.flatMap((report) => report.readerQueueEvidence),
    readerQueuedBytesPeak: Math.max(...reports.map((report) => report.readerQueuedBytesPeak)),
    generatorCpuPercentMax: Math.max(...reports.map((report) => report.generatorCpuPercent)),
    generatorEventLoopP99MsMax: Math.max(
      ...reports.map((report) => report.generatorEventLoopP99Ms)
    ),
    generatorRssGrowthMiBMax: Math.max(...reports.map((report) => report.generatorRssGrowthMiB)),
    configuredSteadySeconds: Math.min(...reports.map((report) => report.configuredSteadySeconds))
  }
}

function assertLoadReports(reports, expected) {
  const shardCount = reports.length
  if (
    reports.some((report, index) =>
      report.event !== 'relay_load_complete' ||
      report.shardCount !== shardCount || report.shardIndex !== index ||
      report.relayAsiaLoadPrincipalCount !== 32 ||
      number(report.configuredSteadySeconds, 'staging steady seconds') < expected.minimumSeconds ||
      number(report.configuredSpliceHoldSeconds, 'staging splice hold seconds') <
        expected.minimumSeconds ||
      report.requiredLeaseHorizons !== 2 || report.phaseBarrierPassed !== true
    ) ||
    total(reports, 'controls') !== expected.controls
  ) {
    throw new Error('staging load profile does not match')
  }
  if (
    total(reports, 'peakActive') !== expected.controls ||
    total(reports, 'steadyMinimumActive') !== expected.controls
  ) {
    throw new Error('staging load did not sustain the required controls')
  }
  for (const key of [
    'rampConnectionFailures', 'steadyConnectionFailures', 'transitionConnectionFailures',
    'unexpectedCloses', 'protocolErrors', 'refreshErrors', 'socketErrors', 'failedSplices'
  ]) {
    if (total(reports, key) !== 0) throw new Error(`staging load ${key} must be zero`)
  }
  const peakActiveSplices = total(reports, 'peakActiveSplices')
  if (
    total(reports, 'configuredSplices') !== expected.splices ||
    total(reports, 'configuredSlowReaderSplices') !== expected.slowReaders ||
    total(reports, 'configuredWedgedReaderSplices') !== expected.wedgedReaders ||
    peakActiveSplices < expected.splices - expected.wedgedReaders ||
    peakActiveSplices > expected.splices ||
    total(reports, 'completedSplices') !== expected.splices - expected.wedgedReaders ||
    total(reports, 'slowReaderSplicesCompleted') !== expected.slowReaders ||
    total(reports, 'wedgedReaderSplicesClosed') !== expected.wedgedReaders
  ) throw new Error('staging mixed load evidence does not match')
  if (
    total(reports, 'regionalFallbacksProved') !== 0 ||
    total(reports, 'oldClientUsFirstProved') !== 1 ||
    total(reports, 'stickyAssignmentProved') !== 1 ||
    total(reports, 'requestUnitInvitesOpened') !== 0 ||
    reports.some((report) => report.requestUnitPrincipalCount !== 0) ||
    total(reports, 'requestUnitCleanupProved') !== 0 ||
    reports.some((report) => report.requestUnitOverflowReason !== null) ||
    total(reports, 'rebindProbesOpened') !== 2 ||
    reports.some((report) => report.rebindOverflowReason !== null)
  ) throw new Error('staging launch-path evidence does not match')
  const readerReports = reports.filter(
    (report) => report.configuredSlowReaderSplices + report.configuredWedgedReaderSplices > 0
  )
  if (expected.slowReaders > 0 && readerReports.length !== 1) {
    throw new Error('staging reader pressure must have one causal owner')
  }
  for (const report of reports) {
    const queue = report.readerQueueEvidence
    if (!Array.isArray(queue)) throw new Error('staging reader queue evidence is invalid')
    if (expected.slowReaders === 0 && queue.length !== 0) {
      throw new Error('control load unexpectedly contains reader queue evidence')
    }
    const ownsReaderPressure = readerReports.includes(report)
    if (expected.slowReaders > 0 && ownsReaderPressure && (
      queue.length !== 1 ||
      queue[0]?.origin !== 'https://c4.relay-staging.onorca.dev' ||
      number(queue[0]?.baselineBytes, 'reader queue baseline') >
        number(queue[0]?.peakBytes, 'reader queue peak') ||
      number(queue[0]?.increaseBytes, 'reader queue increase') <= 0 ||
      queue[0].peakBytes - queue[0].baselineBytes !== queue[0].increaseBytes ||
      report.readerQueuedBytesPeak !== queue[0].increaseBytes
    )) throw new Error('staging reader queue evidence is not causal')
    if (expected.slowReaders > 0 && !ownsReaderPressure && (
      queue.length !== 0 || report.readerQueuedBytesPeak !== 0
    )) throw new Error('non-owner shard contains reader queue evidence')
  }
  for (const report of reports) {
    if (
      number(report.generatorCpuPercent, 'generator CPU') >= GENERATOR_CPU_PERCENT_LIMIT ||
      number(report.generatorEventLoopP99Ms, 'generator event loop') >=
        GENERATOR_EVENT_LOOP_P99_MS_LIMIT ||
      number(report.generatorRssGrowthMiB, 'generator RSS growth') >=
        GENERATOR_RSS_GROWTH_MIB_LIMIT
    ) throw new Error('staging load generator has insufficient headroom')
    const shutdown = object(report.shutdownEvidence, 'load shutdown evidence')
    if (
      shutdown.peerShutdowns !== report.controls || shutdown.activeControls !== 0 ||
      shutdown.activeSplices !== 0 || shutdown.reconnectTimers !== 0
    ) throw new Error('staging load cleanup is incomplete')
  }
}

function number(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function sumMap(value, label) {
  const entries = Object.entries(object(value ?? {}, label))
  return entries.reduce((total, [key, count]) => {
    if (!key) throw new Error(`${label} is invalid`)
    return total + number(count, label)
  }, 0)
}

function assertCoverage(timestamps, start, end, label) {
  if (timestamps.length === 0) throw new Error(`${label} has no samples`)
  const ordered = timestamps.map((value) => instant(value, `${label} timestamp`).valueOf())
    .sort((left, right) => left - right)
  if (
    ordered[0] > start.valueOf() + MAX_LOG_EDGE_GAP_MS ||
    ordered.at(-1) < end.valueOf() - MAX_LOG_EDGE_GAP_MS
  ) throw new Error(`${label} does not cover the canary window`)
  if (ordered.some((timestamp, index) => index > 0 && timestamp - ordered[index - 1] > MAX_LOG_SAMPLE_GAP_MS)) {
    throw new Error(`${label} has a sampling gap`)
  }
}

function pointValue(point) {
  const value = point?.value
  if (typeof value?.doubleValue === 'number') return value.doubleValue
  if (typeof value?.int64Value === 'string') return Number(value.int64Value)
  return NaN
}

function cloudSqlMaximum(response, start, end) {
  const points = (object(response, 'Cloud SQL response').timeSeries ?? [])
    .flatMap((series) => series.points ?? [])
  assertCoverage(points.map((point) => point.interval?.endTime), start, end, 'Cloud SQL metrics')
  const values = points.map(pointValue)
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Cloud SQL backend metric is invalid')
  }
  return Math.max(...values)
}

export function buildC27CanaryEvidence(input) {
  const start = instant(input.startedAt, 'canary start')
  const end = instant(input.endedAt, 'canary end')
  if (end.valueOf() - start.valueOf() < C27_CANARY_MINIMUM_MS) {
    throw new Error('C27 canary window is shorter than 5 minutes')
  }
  const load = object(input.loadReport, 'C27 load report')
  assertC27CanaryLoad(load)
  const metrics = runtimeMetrics(input.logs, start, end, C27)
  assertPassingRuntimeMetrics(metrics, 'C27 canary')
  metrics.cloudSqlBackendsMax = cloudSqlMaximum(input.cloudSql, start, end)
  assertPassingCanary(metrics)
  return {
    ...baseEvidence(input, 'production', [C27]),
    kind: 'production-c27-canary',
    window: { startedAt: start.toISOString(), endedAt: end.toISOString() },
    load,
    metrics
  }
}

function assertC27CanaryLoad(report) {
  if (
    report.event !== 'relay_load_complete' ||
    report.controls !== 1 || report.shardCount !== 1 || report.shardIndex !== 0 ||
    report.relayAsiaLoadPrincipalCount !== 1 ||
    number(report.configuredSteadySeconds, 'canary steady seconds') < 300 ||
    number(report.configuredSpliceHoldSeconds, 'canary splice hold seconds') < 60 ||
    number(report.requiredLeaseHorizons, 'canary lease horizons') < 2 ||
    report.peakActive !== 1 || report.steadyMinimumActive !== 1 ||
    report.configuredSplices !== 1 || report.peakActiveSplices !== 1 ||
    report.completedSplices !== 1 || report.failedSplices !== 0
  ) throw new Error('C27 control and splice canary did not match')
  for (const key of [
    'connectionFailures', 'unexpectedCloses', 'protocolErrors',
    'refreshErrors', 'socketErrors'
  ]) {
    if (number(report[key], key) !== 0) throw new Error(`C27 canary ${key} must be zero`)
  }
  const shutdown = object(report.shutdownEvidence, 'C27 load shutdown evidence')
  if (
    shutdown.peerShutdowns !== 1 || shutdown.activeControls !== 0 ||
    shutdown.activeSplices !== 0 || shutdown.reconnectTimers !== 0
  ) throw new Error('C27 load cleanup is incomplete')
}

function runtimeMetrics(logs, start, end, targetCellId) {
  const entries = logs.map((entry) => object(entry, 'runtime metric entry'))
  const directorEntries = entries.filter((entry) => entry.jsonPayload?.role === 'director')
  const cellEntries = entries.filter((entry) =>
    entry.jsonPayload?.role === 'cell' &&
    entry.jsonPayload?.cellId === targetCellId &&
    entry.jsonPayload?.region === 'asia-east2'
  )
  assertCoverage(directorEntries.map((entry) => entry.timestamp), start, end, 'director metrics')
  assertCoverage(cellEntries.map((entry) => entry.timestamp), start, end, `${targetCellId} metrics`)
  const identifiedDirectors = Map.groupBy(
    directorEntries.filter((entry) => entry.resource?.labels?.instance_id),
    (entry) => entry.resource.labels.instance_id
  )
  for (const [instanceId, instanceEntries] of identifiedDirectors) {
    assertCoverage(instanceEntries.map((entry) => entry.timestamp), start, end, `director ${instanceId}`)
  }
  const directorPayloads = directorEntries.map((entry) => entry.jsonPayload)
  const cellPayloads = cellEntries.map((entry) => entry.jsonPayload)
  const payloads = [...directorPayloads, ...cellPayloads]
  return {
    asiaSelections: directorPayloads.reduce(
      (total, payload) => total + number(payload.selectedRegionsDelta?.['asia-east2'] ?? 0, 'Asia selections'), 0
    ),
    regionFallbacks: directorPayloads.reduce(
      (total, payload) => total + sumMap(payload.regionFallbacksDelta, 'region fallbacks'), 0
    ),
    usRegionFallbacks: directorPayloads.reduce(
      (total, payload) => total + number(
        payload.regionFallbacksDelta?.['us-central1'] ?? 0,
        'US region fallbacks'
      ), 0
    ),
    unavailableRegions: directorPayloads.reduce(
      (total, payload) => total + sumMap(payload.unavailableRegionsDelta, 'unavailable regions'), 0
    ),
    relaySqlFailures: payloads.reduce(
      (total, payload) => total + number(payload.sqlFailuresDelta, 'Relay SQL failures'), 0
    ),
    databasePoolWaitingMax: Math.max(...payloads.map(
      (payload) => number(payload.databasePoolWaiting, 'database pool waiting')
    )),
    databasePoolWaitersMax: Math.max(...payloads.map(
      (payload) => number(payload.databasePoolWaitersMax, 'database pool waiters')
    )),
    databasePoolWaitMsMax: Math.max(...payloads.map(
      (payload) => number(payload.databasePoolWaitMsMax, 'database pool wait time')
    )),
    targetControlsMax: Math.max(...cellPayloads.map(
      (payload) => number(payload.controls, 'target controls')
    )),
    targetSplicesMax: Math.max(...cellPayloads.map(
      (payload) => number(payload.splices, 'target splices')
    ))
  }
}

function assertPassingRuntimeMetrics(metrics, label, expectedRegionFallbacks = 0) {
  if (number(metrics.asiaSelections, 'Asia selections') < 1) {
    throw new Error(`${label} observed no Asia selections`)
  }
  if (
    number(metrics.regionFallbacks, 'regionFallbacks') !== expectedRegionFallbacks ||
    number(metrics.usRegionFallbacks, 'usRegionFallbacks') !== expectedRegionFallbacks
  ) {
    throw new Error(`${label} regionFallbacks did not match the intentional probes`)
  }
  for (const key of [
    'unavailableRegions', 'relaySqlFailures', 'databasePoolWaitingMax'
  ]) {
    if (number(metrics[key], key) !== 0) throw new Error(`${label} ${key} must be zero`)
  }
  if (
    number(metrics.databasePoolWaitersMax, 'databasePoolWaitersMax') >
      DATABASE_POOL_TRANSIENT_WAITERS_MAX ||
    number(metrics.databasePoolWaitMsMax, 'databasePoolWaitMsMax') >
      DATABASE_POOL_TRANSIENT_WAIT_MS_MAX
  ) throw new Error(`${label} transient database pool pressure exceeded its bound`)
}

function assertPassingCanary(metrics) {
  if (
    number(metrics.targetControlsMax, 'C27 controls') < 1 ||
    number(metrics.targetSplicesMax, 'C27 splices') < 1
  ) throw new Error('C27 canary traffic did not reach C27')
  if (number(metrics.cloudSqlBackendsMax, 'Cloud SQL backends') >= CLOUD_SQL_LIMIT) {
    throw new Error(`Cloud SQL backends must remain below ${CLOUD_SQL_LIMIT}`)
  }
}

function assertProvenance(evidence, run, expected) {
  const evidenceSource = object(evidence.source, 'evidence source')
  if (
    run.id !== evidenceSource.runId ||
    run.run_attempt !== evidenceSource.runAttempt ||
    run.conclusion !== 'success' ||
    run.event !== 'workflow_dispatch' ||
    run.head_branch !== 'main' ||
    run.head_sha !== evidenceSource.commitSha ||
    run.repository?.full_name !== evidenceSource.repository ||
    run.path?.split('@')[0] !== expected.workflow ||
    evidenceSource.workflow !== expected.workflow ||
    evidenceSource.repository !== REPOSITORY ||
    expected.repository !== REPOSITORY ||
    evidenceSource.environment !== expected.environment ||
    evidenceSource.commitSha !== expected.commitSha
  ) throw new Error('evidence workflow provenance does not match')
}

export function verifyRolloutEvidence(evidence, run, expected) {
  object(evidence, 'evidence')
  object(run, 'workflow run')
  if (evidence.version !== 1 || evidence.kind !== expected.kind) {
    throw new Error('evidence kind is invalid')
  }
  assertProvenance(evidence, run, expected)
  if (evidence.imageDigest !== expected.imageDigest) throw new Error('evidence image digest does not match')
  if (!exactCells(evidence.topology?.cellIds, expected.cellIds)) {
    throw new Error('evidence topology does not match')
  }
  positiveInteger(evidence.topology?.selectorGeneration, 'evidence selector generation')
  if (
    expected.selectorGeneration !== undefined &&
    evidence.topology.selectorGeneration !== expected.selectorGeneration
  ) throw new Error('evidence selector generation does not match')
  const now = instant(expected.now, 'verification time')
  const proofTime = instant(evidence.window?.endedAt, 'evidence time')
  const maxAgeMs = expected.kind === 'staging-asia-readiness' ? 24 * 60 * 60_000 : 6 * 60 * 60_000
  if (proofTime > now || now.valueOf() - proofTime.valueOf() > maxAgeMs) {
    throw new Error('rollout evidence is stale')
  }
  if (expected.kind === 'production-c27-canary') {
    const start = instant(evidence.window?.startedAt, 'canary start')
    if (proofTime.valueOf() - start.valueOf() < C27_CANARY_MINIMUM_MS) {
      throw new Error('C27 canary window is shorter than 5 minutes')
    }
    assertC27CanaryLoad(object(evidence.load, 'canary load'))
    assertPassingCanary(object(evidence.metrics, 'canary metrics'))
  }
  return evidence
}

function argumentsMap(argv) {
  const values = new Map()
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined || values.has(key.slice(2))) {
      throw new Error('invalid rollout evidence arguments')
    }
    values.set(key.slice(2), value)
  }
  return { command: argv[0], values }
}

function required(values, key) {
  const value = values.get(key)
  if (!value) throw new Error(`missing --${key}`)
  return value
}

function commonInput(values) {
  return {
    repository: required(values, 'repository'), runId: required(values, 'run-id'),
    runAttempt: required(values, 'run-attempt'), commitSha: required(values, 'commit-sha'),
    imageDigest: required(values, 'image-digest'),
    selectorGeneration: required(values, 'selector-generation')
  }
}

async function main(argv) {
  const { command, values } = argumentsMap(argv)
  const output = required(values, 'output')
  if (command === 'create-staging') {
    writeFileSync(output, `${JSON.stringify(buildStagingEvidence({
      ...commonInput(values), startedAt: required(values, 'started-at'),
      endedAt: required(values, 'ended-at'),
      launchReport: JSON.parse(readFileSync(required(values, 'launch-report'), 'utf8')),
      logs: JSON.parse(readFileSync(required(values, 'logs-json'), 'utf8')),
      cloudSql: await readCloudSqlBackends(
        'staging', required(values, 'started-at'), required(values, 'ended-at')
      )
    }), null, 2)}\n`)
    return
  }
  if (command === 'create-c27') {
    const startedAt = required(values, 'started-at')
    const endedAt = required(values, 'ended-at')
    writeFileSync(output, `${JSON.stringify(buildC27CanaryEvidence({
      ...commonInput(values), startedAt, endedAt,
      loadReport: JSON.parse(readFileSync(required(values, 'load-report'), 'utf8')),
      logs: JSON.parse(readFileSync(required(values, 'logs-json'), 'utf8')),
      cloudSql: await readCloudSqlBackends('production', startedAt, endedAt)
    }), null, 2)}\n`)
    return
  }
  if (!['verify-staging', 'verify-c27'].includes(command)) throw new Error('invalid evidence command')
  const kind = command === 'verify-staging' ? 'staging-asia-readiness' : 'production-c27-canary'
  verifyRolloutEvidence(
    JSON.parse(readFileSync(required(values, 'evidence'), 'utf8')),
    JSON.parse(readFileSync(required(values, 'run-json'), 'utf8')),
    {
      kind, repository: REPOSITORY,
      workflow: kind === 'staging-asia-readiness' ? STAGING_WORKFLOW : ADMISSION_WORKFLOW,
      environment: kind === 'staging-asia-readiness' ? 'staging' : 'production',
      commitSha: required(values, 'commit-sha'), imageDigest: required(values, 'image-digest'),
      cellIds: [kind === 'staging-asia-readiness' ? STAGING_CELL : C27],
      selectorGeneration: values.has('selector-generation')
        ? positiveInteger(values.get('selector-generation'), 'selector generation') : undefined,
      now: required(values, 'now')
    }
  )
  writeFileSync(output, 'verified\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
