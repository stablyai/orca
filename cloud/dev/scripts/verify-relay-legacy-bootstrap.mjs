import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const CAPACITY_PROTOCOL = 2
const LEGACY_RUNTIME_KEYS = ['cellId', 'cellUrl', 'imageDigest', 'role', 'v']
const METRIC_COUNTS = [
  'totalConnections',
  'preAuthConnections',
  'controls',
  'splices',
  'pendingSplices',
  'queuedBytes'
]

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid`)
  return value
}

export function parseLegacyBootstrapArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments')
    values[key.slice(2)] = value
  }
  for (const key of [
    'director-origin',
    'cell-origin',
    'cell-id',
    'admission',
    'expected-image-digest',
    'metrics-after',
    'metrics-file'
  ]) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  if (!['general', 'migration-only'].includes(values.admission)) {
    throw new Error('--admission must be general or migration-only')
  }
  const directorOrigin = new URL(values['director-origin'])
  const cellOrigin = new URL(values['cell-origin'])
  if (
    directorOrigin.protocol !== 'https:' ||
    directorOrigin.origin !== values['director-origin'] ||
    cellOrigin.protocol !== 'https:' ||
    cellOrigin.origin !== values['cell-origin']
  ) {
    throw new Error('origins must be canonical HTTPS origins')
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(values['expected-image-digest'])) {
    throw new Error('--expected-image-digest is invalid')
  }
  const metricsAfter = Date.parse(values['metrics-after'])
  if (!Number.isFinite(metricsAfter)) throw new Error('--metrics-after is invalid')
  const runtimeStartedAfter = values['runtime-started-after'] === undefined
    ? undefined
    : Date.parse(values['runtime-started-after'])
  if (runtimeStartedAfter !== undefined && !Number.isFinite(runtimeStartedAfter)) {
    throw new Error('--runtime-started-after is invalid')
  }
  const previousIncarnationDigest = values['previous-incarnation-digest']
  if (
    previousIncarnationDigest !== undefined &&
    !/^[a-f0-9]{64}$/.test(previousIncarnationDigest)
  ) {
    throw new Error('--previous-incarnation-digest is invalid')
  }
  const hardCap = values['hard-cap'] === undefined
    ? undefined
    : integer(Number(values['hard-cap']), '--hard-cap')
  const unobservedBound = values['unobserved-bound'] === undefined
    ? undefined
    : integer(Number(values['unobserved-bound']), '--unobserved-bound')
  if ((hardCap === undefined) !== (unobservedBound === undefined)) {
    throw new Error('capacity expectations must be paired')
  }
  const capacityState = values['capacity-state'] ?? (hardCap === undefined ? 'absent' : 'stale')
  if (!['absent', 'stale', 'absent-or-stale'].includes(capacityState)) {
    throw new Error('--capacity-state is invalid')
  }
  if ((capacityState === 'absent') !== (hardCap === undefined)) {
    throw new Error('capacity state and expectations do not match')
  }
  return {
    directorOrigin: directorOrigin.origin,
    cellOrigin: cellOrigin.origin,
    cellId: values['cell-id'],
    admission: values.admission,
    expectedImageDigest: values['expected-image-digest'],
    metricsAfter,
    metricsFile: values['metrics-file'],
    runtimeStartedAfter,
    previousIncarnationDigest,
    hardCap,
    unobservedBound,
    capacityState
  }
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${label} returned ${response.status}`)
  return body
}

function requireLegacyRuntime(runtime, config) {
  if (JSON.stringify(Object.keys(runtime).sort()) !== JSON.stringify(LEGACY_RUNTIME_KEYS)) {
    throw new Error('cell runtime does not match the reviewed legacy contract')
  }
  if (
    runtime.v !== 1 ||
    runtime.role !== 'cell' ||
    runtime.cellId !== config.cellId ||
    runtime.cellUrl !== config.cellOrigin ||
    runtime.imageDigest !== config.expectedImageDigest
  ) {
    throw new Error('legacy cell runtime identity does not match')
  }
}

function requireDirectorQuiescence(status, config, now) {
  const capacity = status.connectionCapacity
  const staleCapacityTransition = config.capacityState !== 'absent' && capacity !== null
  if (
    status.cellId !== config.cellId ||
    status.cellUrl !== config.cellOrigin ||
    status.enabled !== true ||
    status.admissionState !== config.admission ||
    status.runtime?.ready !== true ||
    (status.runtime.heartbeatFresh !== true &&
      !(staleCapacityTransition && status.runtime.heartbeatFresh === false)) ||
    status.runtime.cellUrl !== config.cellOrigin
  ) {
    throw new Error('legacy cell is not fresh, ready, and in the required admission state')
  }
  if (config.capacityState === 'absent' && capacity !== null) {
    throw new Error('legacy cell has unexpected connection capacity')
  }
  if (
    config.capacityState !== 'absent' &&
    !(config.capacityState === 'absent-or-stale' && capacity === null) &&
    (capacity?.hardCap !== config.hardCap ||
      capacity.unobservedBound !== config.unobservedBound ||
      capacity.controlRebindReserve !== 100 ||
      capacity.ordinaryConnectionLimit !== config.hardCap - 100 ||
      capacity.normalAdmissionPause !== config.hardCap - 100 - config.unobservedBound ||
      capacity.heartbeatFresh !== false)
  ) {
    throw new Error('legacy cell connection capacity does not match')
  }
  integer(status.runtime.startedAt, 'runtime started at')
  integer(status.runtime.lastHeartbeatAt, 'runtime heartbeat at')
  if (!/^[0-9a-f-]{36}$/.test(status.runtime.cellIncarnation)) {
    throw new Error('runtime cell incarnation is invalid')
  }
  const incarnationDigest = createHash('sha256')
    .update(status.runtime.cellIncarnation)
    .digest('hex')
  if (incarnationDigest === config.previousIncarnationDigest) {
    throw new Error('legacy fallback heartbeat incarnation did not change')
  }
  if (
    config.runtimeStartedAfter !== undefined &&
    (integer(status.runtime.startedAt, 'runtime started at') < config.runtimeStartedAfter ||
      status.runtime.startedAt > now + 30_000)
  ) {
    throw new Error('legacy fallback heartbeat predates the replacement')
  }
  const activity = [
    status.reservedRequests,
    status.activityLeases,
    status.activityRequestUnits,
    status.outgoingMigrations,
    status.incomingMigrations,
    status.runtime.observedRequests
  ]
  if (capacity !== null) {
    activity.push(
      capacity.observedConnections,
      capacity.inFlightConnections,
      capacity.reservedConnectionUnits,
      capacity.enforcedConnectionUnits,
      capacity.pendingControlReservations
    )
  }
  if (activity.some((value) => integer(value, 'director activity count') !== 0)) {
    throw new Error('legacy fallback has durable activity')
  }
  integer(status.assignments, 'assignments')
  return incarnationDigest
}

function requireFreshZeroMetrics(metrics, config, now) {
  if (!Array.isArray(metrics)) throw new Error('legacy runtime metrics are invalid')
  const samples = metrics.filter((entry) => {
    const timestamp = Date.parse(entry?.timestamp)
    return Number.isFinite(timestamp) && timestamp >= config.metricsAfter && timestamp <= now + 30_000
  })
  const timestamps = new Set(samples.map((entry) => entry.timestamp))
  if (samples.length < 2 || timestamps.size < 2) {
    throw new Error('legacy runtime metrics need two post-boundary samples')
  }
  const latest = Math.max(...samples.map((entry) => Date.parse(entry.timestamp)))
  if (latest < now - 90_000) throw new Error('legacy runtime metrics are stale')
  for (const sample of samples) {
    if (sample.cellId !== config.cellId || sample.metricVersion !== 1) {
      throw new Error('legacy runtime metrics do not match the cell')
    }
    if (METRIC_COUNTS.some((field) => integer(sample[field], field) !== 0)) {
      throw new Error('legacy runtime metrics are not quiescent')
    }
  }
  return samples.length
}

export async function verifyLegacyBootstrap(config, overrides = {}) {
  const fetchImpl = overrides.fetch ?? fetch
  const token = overrides.token ?? process.env.ORCA_RELAY_ADMIN_ID_TOKEN
  const now = overrides.now?.() ?? Date.now()
  const metrics = overrides.metrics ?? JSON.parse(readFileSync(config.metricsFile, 'utf8'))
  if (!token || token.length > 8_192) throw new Error('admin identity token is unavailable')
  const publicChecks = await Promise.all([
    responseJson(
      await fetchImpl(`${config.directorOrigin}/health`, {
        signal: AbortSignal.timeout(15_000)
      }),
      'director health'
    ),
    responseJson(
      await fetchImpl(`${config.cellOrigin}/health`, { signal: AbortSignal.timeout(15_000) }),
      'cell health'
    ),
    responseJson(
      await fetchImpl(`${config.cellOrigin}/ready`, { signal: AbortSignal.timeout(15_000) }),
      'cell readiness'
    )
  ])
  if (
    publicChecks[0].ok !== true ||
    publicChecks[0].connectionCapacityProtocol !== CAPACITY_PROTOCOL ||
    publicChecks[1].ok !== true ||
    publicChecks[2].ok !== true
  ) {
    throw new Error('legacy fallback public checks failed')
  }
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const [runtime, result] = await Promise.all([
    responseJson(
      await fetchImpl(`${config.cellOrigin}/v1/admin/runtime-status`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ v: 1 }),
        signal: AbortSignal.timeout(30_000)
      }),
      'cell runtime status'
    ),
    responseJson(
      await fetchImpl(`${config.directorOrigin}/v1/admin/cell-status`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ v: 1, cellId: config.cellId }),
        signal: AbortSignal.timeout(30_000)
      }),
      'cell status'
    )
  ])
  requireLegacyRuntime(runtime, config)
  const incarnationDigest = requireDirectorQuiescence(result.status, config, now)
  const metricSamples = requireFreshZeroMetrics(metrics, config, now)
  return {
    cellId: config.cellId,
    admissionState: result.status.admissionState,
    assignments: integer(result.status.assignments, 'assignments'),
    metricSamples,
    incarnationDigest
  }
}

export async function main(argv = process.argv.slice(2)) {
  const result = await verifyLegacyBootstrap(parseLegacyBootstrapArguments(argv))
  process.stdout.write(`${JSON.stringify({ event: 'relay_legacy_bootstrap_verified', ...result })}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
