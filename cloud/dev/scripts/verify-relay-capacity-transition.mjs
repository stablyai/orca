import { pathToFileURL } from 'node:url'

const CAPACITY_PROTOCOL = 2

function integer(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`)
  return parsed
}

function signedInteger(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

export function parseCapacityTransitionArguments(argv) {
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
    'heartbeat',
    'admission',
    'draining',
    'activity'
  ]) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  if (!['fresh', 'stale', 'either'].includes(values.heartbeat)) {
    throw new Error('--heartbeat must be fresh, stale, or either')
  }
  if (
    !['general', 'migration-only', 'general-or-migration-only', 'non-general', 'either'].includes(
      values.admission
    )
  ) {
    throw new Error(
      '--admission must be general, migration-only, general-or-migration-only, non-general, or either'
    )
  }
  if (!['required', 'forbidden', 'either'].includes(values.draining)) {
    throw new Error('--draining must be required, forbidden, or either')
  }
  if (!['quiescent', 'restart-safe', 'allowed'].includes(values.activity)) {
    throw new Error('--activity must be quiescent, restart-safe, or allowed')
  }
  const runtime = values.runtime ?? 'required'
  if (!['required', 'unavailable'].includes(runtime)) {
    throw new Error('--runtime must be required or unavailable')
  }
  if (
    values.activity === 'restart-safe' &&
    runtime === 'required' &&
    (values.admission !== 'migration-only' || values.draining !== 'required')
  ) {
    throw new Error('restart-safe activity requires migration-only admission and draining')
  }
  if (
    runtime === 'unavailable' &&
    (values.heartbeat !== 'stale' ||
      values.admission !== 'migration-only' ||
      values.draining !== 'either' ||
      values.activity !== 'restart-safe')
  ) {
    throw new Error('unavailable runtime requires stale migration-only durable state')
  }
  const origin = new URL(values['director-origin'])
  const cellOrigin = new URL(values['cell-origin'])
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== values['director-origin'] ||
    cellOrigin.protocol !== 'https:' ||
    cellOrigin.origin !== values['cell-origin']
  ) {
    throw new Error('origins must be canonical HTTPS origins')
  }
  const hardCap = values['hard-cap'] === undefined
    ? undefined
    : integer(values['hard-cap'], '--hard-cap')
  const unobservedBound = values['unobserved-bound'] === undefined
    ? undefined
    : integer(values['unobserved-bound'], '--unobserved-bound')
  if ((hardCap === undefined) !== (unobservedBound === undefined)) {
    throw new Error('capacity expectations must be paired')
  }
  if (runtime === 'unavailable' && hardCap !== undefined) {
    throw new Error('unavailable runtime cannot prove live capacity')
  }
  const expectedImageDigests = values['expected-image-digests']?.split(',') ?? []
  if (
    new Set(expectedImageDigests).size !== expectedImageDigests.length ||
    expectedImageDigests.some((digest) => !/^sha256:[a-f0-9]{64}$/.test(digest))
  ) {
    throw new Error('--expected-image-digests is invalid')
  }
  if (runtime === 'unavailable' && expectedImageDigests.length > 0) {
    throw new Error('unavailable runtime cannot prove a live image')
  }
  const regionalRehomeProtocol = values['regional-rehome-protocol'] === undefined
    ? undefined
    : integer(values['regional-rehome-protocol'], '--regional-rehome-protocol')
  if (regionalRehomeProtocol !== undefined && ![0, 1].includes(regionalRehomeProtocol)) {
    throw new Error('--regional-rehome-protocol must be 0 or 1')
  }
  if (runtime === 'unavailable' && regionalRehomeProtocol !== undefined) {
    throw new Error('unavailable runtime cannot prove the regional rehome protocol')
  }
  return {
    directorOrigin: origin.origin,
    cellOrigin: cellOrigin.origin,
    cellId: values['cell-id'],
    heartbeat: values.heartbeat,
    admission: values.admission,
    draining: values.draining,
    activity: values.activity,
    runtime,
    expectedImageDigests,
    ...(regionalRehomeProtocol === undefined ? {} : { regionalRehomeProtocol }),
    hardCap,
    unobservedBound,
    timeoutMs: integer(values['timeout-ms'] ?? 180_000, '--timeout-ms')
  }
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${label} returned ${response.status}`)
  return body
}

async function cellRuntime(fetchImpl, config, token) {
  let response
  try {
    response = await fetchImpl(`${config.cellOrigin}/v1/admin/runtime-status`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1 }),
      signal: AbortSignal.timeout(30_000)
    })
  } catch (error) {
    if (config.runtime === 'unavailable') return null
    throw error
  }
  if ([502, 503, 504].includes(response.status)) {
    await response.arrayBuffer().catch(() => undefined)
    return null
  }
  return await responseJson(response, 'cell runtime status')
}

function offlineRollbackMatches(status, config) {
  if (status.admissionState !== 'migration-only') {
    throw new Error('capacity transition admission does not match the required state')
  }
  const durableCounts = [
    status.activityLeases,
    status.activityRequestUnits,
    status.reservedRequests,
    status.restartBlockingActivityLeases,
    status.restartBlockingActivityRequestUnits,
    status.outgoingMigrations,
    status.incomingMigrations,
    status.connectionCapacity?.pendingControlReservations
  ]
  const restartBlockingReservedRequests = signedInteger(
    status.restartBlockingReservedRequests,
    'restart-blocking reserved requests'
  )
  // Only a positive remainder is unexplained; the other gates reject real work.
  return heartbeatMatches(status, config.heartbeat) &&
    durableCounts.every((value) => integer(value, 'durable activity count') === 0) &&
    restartBlockingReservedRequests <= 0
}

function directorActivityMatches(status, config, restartBlockingReservedRequests) {
  const durable = [
    status.activityLeases,
    status.reservedRequests,
    status.outgoingMigrations,
    status.incomingMigrations
  ]
  // Reconnect reservations survive replacement; draining prevents activation on this process.
  const transient = [
    status.connectionCapacity?.observedConnections,
    status.connectionCapacity?.inFlightConnections,
    status.connectionCapacity?.reservedConnectionUnits,
    status.connectionCapacity?.enforcedConnectionUnits,
    status.connectionCapacity?.pendingControlReservations
  ]
  const restartSafe = config.activity !== 'restart-safe' || (() => {
    // Only a positive remainder is unexplained; the other gates reject real work.
    return integer(
      status.restartBlockingActivityLeases,
      'restart-blocking activity leases'
    ) === 0 &&
      integer(
        status.restartBlockingActivityRequestUnits,
        'restart-blocking activity request units'
      ) === 0 &&
      restartBlockingReservedRequests <= 0 &&
      integer(status.outgoingMigrations, 'outgoing migrations') === 0 &&
      integer(status.incomingMigrations, 'incoming migrations') === 0
  })()
  const quiescent = [...durable, ...transient]
    .filter((value) => value !== undefined)
    .every((value) => integer(value, 'activity count') === 0)
  if (
    (config.admission === 'general' && status.admissionState !== 'general') ||
    (config.admission === 'migration-only' && status.admissionState !== 'migration-only') ||
    // A failed same-cap canary leaves its cell migration-only; the documented
    // rollback recovery must accept that state alongside a completed general roll.
    (config.admission === 'general-or-migration-only' &&
      !['general', 'migration-only'].includes(status.admissionState)) ||
    (config.admission === 'non-general' &&
      !['existing-only', 'migration-only'].includes(status.admissionState))
  ) {
    throw new Error('capacity transition admission does not match the required state')
  }
  return config.activity === 'allowed' ||
    (config.activity === 'restart-safe' ? restartSafe : quiescent)
}

function capacityMatches(status, config) {
  if (config.hardCap === undefined) return true
  const capacity = status.connectionCapacity
  return (
    capacity?.hardCap === config.hardCap &&
    capacity.unobservedBound === config.unobservedBound &&
    capacity.controlRebindReserve === 100 &&
    capacity.ordinaryConnectionLimit === config.hardCap - 100 &&
    capacity.normalAdmissionPause === config.hardCap - 100 - config.unobservedBound
  )
}

function heartbeatMatches(status, expectation) {
  if (expectation === 'either') return true
  const fresh = status.connectionCapacity?.heartbeatFresh ?? status.runtime?.heartbeatFresh
  return fresh === (expectation === 'fresh')
}

function aggregateCount(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function signedAggregateCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function capacityObservation(capacity) {
  if (capacity === null || capacity === undefined) return null
  return {
    hardCap: aggregateCount(capacity.hardCap),
    controlRebindReserve: aggregateCount(capacity.controlRebindReserve),
    ordinaryConnectionLimit: aggregateCount(capacity.ordinaryConnectionLimit),
    unobservedBound: aggregateCount(capacity.unobservedBound),
    normalAdmissionPause: aggregateCount(capacity.normalAdmissionPause),
    observedConnections: aggregateCount(capacity.observedConnections),
    inFlightConnections: aggregateCount(capacity.inFlightConnections),
    reservedConnectionUnits: aggregateCount(capacity.reservedConnectionUnits),
    enforcedConnectionUnits: aggregateCount(capacity.enforcedConnectionUnits),
    pendingControlReservations: aggregateCount(capacity.pendingControlReservations),
    heartbeatFresh: typeof capacity.heartbeatFresh === 'boolean'
      ? capacity.heartbeatFresh
      : null
  }
}

function transitionObservation(runtime, status) {
  return {
    runtimeAvailable: runtime !== null,
    admissionState: ['general', 'migration-only', 'existing-only'].includes(status.admissionState)
      ? status.admissionState
      : null,
    draining: typeof runtime?.draining === 'boolean' ? runtime.draining : null,
    runtime: runtime === null
      ? null
      : {
          totalConnections: aggregateCount(runtime.runtime?.totalConnections),
          preAuthConnections: aggregateCount(runtime.runtime?.preAuthConnections),
          inFlightConnections: aggregateCount(runtime.runtime?.inFlightConnections),
          reservedConnectionUnits: aggregateCount(runtime.runtime?.reservedConnectionUnits),
          enforcedConnectionUnits: aggregateCount(runtime.runtime?.enforcedConnectionUnits),
          controls: aggregateCount(runtime.runtime?.controls),
          splices: aggregateCount(runtime.runtime?.splices),
          pendingSplices: aggregateCount(runtime.runtime?.pendingSplices),
          queuedBytes: aggregateCount(runtime.runtime?.queuedBytes)
        },
    director: {
      activityLeases: aggregateCount(status.activityLeases),
      activityRequestUnits: aggregateCount(status.activityRequestUnits),
      reservedRequests: aggregateCount(status.reservedRequests),
      restartBlockingActivityLeases: aggregateCount(status.restartBlockingActivityLeases),
      restartBlockingActivityRequestUnits:
        aggregateCount(status.restartBlockingActivityRequestUnits),
      restartBlockingReservedRequests:
        signedAggregateCount(status.restartBlockingReservedRequests),
      outgoingMigrations: aggregateCount(status.outgoingMigrations),
      incomingMigrations: aggregateCount(status.incomingMigrations)
    },
    runtimeCapacity: capacityObservation(runtime?.connectionCapacity),
    directorCapacity: capacityObservation(status.connectionCapacity),
    runtimeHeartbeatFresh: typeof status.runtime?.heartbeatFresh === 'boolean'
      ? status.runtime.heartbeatFresh
      : null
  }
}

function runtimeQuiescent(runtime, config) {
  if (
    runtime.role !== 'cell' ||
    runtime.cellId !== config.cellId ||
    runtime.cellUrl !== config.cellOrigin ||
    // Legacy pre-rehome images omit the field; the exact digest binds absence to protocol 0.
    (config.regionalRehomeProtocol !== undefined &&
      (runtime.regionalRehomeProtocol ?? 0) !== config.regionalRehomeProtocol) ||
    (config.expectedImageDigests?.length > 0 &&
      !config.expectedImageDigests.includes(runtime.imageDigest))
  ) {
    throw new Error('capacity transition runtime does not match the cell')
  }
  if (
    (config.draining === 'required' && runtime.draining !== true) ||
    (config.draining === 'forbidden' && runtime.draining === true)
  ) {
    return false
  }
  const counts = [runtime.runtime?.totalConnections, runtime.runtime?.preAuthConnections]
  if (counts.some((value) => value === undefined)) {
    throw new Error('capacity transition runtime is incomplete')
  }
  if (runtime.connectionCapacity !== null && runtime.connectionCapacity !== undefined) {
    if (runtime.runtime?.enforcedConnectionUnits === undefined) {
      throw new Error('capacity transition runtime is incomplete')
    }
    counts.push(runtime.runtime.enforcedConnectionUnits)
  }
  const quiescent = counts.every((value) => integer(value, 'runtime connection count') === 0)
  const restartSafe = config.activity !== 'restart-safe' ||
    [
      runtime.runtime?.preAuthConnections,
      runtime.runtime?.inFlightConnections,
      runtime.runtime?.reservedConnectionUnits,
      runtime.runtime?.controls,
      runtime.runtime?.splices,
      runtime.runtime?.pendingSplices,
      runtime.runtime?.queuedBytes
    ].every((value) => integer(value, 'live runtime count') === 0)
  if (
    config.heartbeat === 'fresh' &&
    !capacityMatches({ connectionCapacity: runtime.connectionCapacity }, config)
  ) {
    return false
  }
  return config.activity === 'allowed' ||
    (config.activity === 'restart-safe' ? restartSafe : quiescent)
}

export async function verifyCapacityTransition(config, overrides = {}) {
  if (
    config.activity === 'restart-safe' &&
    config.runtime !== 'unavailable' &&
    (config.admission !== 'migration-only' || config.draining !== 'required')
  ) {
    throw new Error('restart-safe activity requires migration-only admission and draining')
  }
  const fetchImpl = overrides.fetch ?? fetch
  const wait = overrides.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = overrides.now ?? Date.now
  const token = overrides.token ?? process.env.ORCA_RELAY_ADMIN_ID_TOKEN
  if (!token || token.length > 8_192) throw new Error('admin identity token is unavailable')
  const health = await responseJson(
    await fetchImpl(`${config.directorOrigin}/health`, {
      signal: AbortSignal.timeout(15_000)
    }),
    'director health'
  )
  if (health.ok !== true || health.connectionCapacityProtocol !== CAPACITY_PROTOCOL) {
    throw new Error('director is not capacity-protocol compatible')
  }
  const deadline = now() + config.timeoutMs
  let restartSafeSamples = 0
  let lastObservation = { runtimeAvailable: false }
  for (;;) {
    const runtime = await cellRuntime(fetchImpl, config, token)
    lastObservation = { runtimeAvailable: runtime !== null }
    if ((runtime === null) === (config.runtime === 'unavailable')) {
      const result = await responseJson(
        await fetchImpl(`${config.directorOrigin}/v1/admin/cell-status`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ v: 1, cellId: config.cellId }),
          signal: AbortSignal.timeout(30_000)
        }),
        'cell status'
      )
      const status = result.status
      if (
        status?.cellId !== config.cellId ||
        status.cellUrl !== config.cellOrigin ||
        status.runtime?.cellUrl !== config.cellOrigin
      ) {
        throw new Error('capacity transition director status does not match the cell')
      }
      lastObservation = transitionObservation(runtime, status)
      const restartBlockingReservedRequests =
        config.activity === 'restart-safe'
          ? signedInteger(
              status.restartBlockingReservedRequests,
              'restart-blocking reserved requests'
            )
          : null
      const matches = runtime === null
        ? offlineRollbackMatches(status, config)
        : runtimeQuiescent(runtime, config) &&
          directorActivityMatches(status, config, restartBlockingReservedRequests) &&
          capacityMatches(status, config) &&
          heartbeatMatches(status, config.heartbeat)
      if (matches && (config.activity !== 'restart-safe' || restartSafeSamples === 1)) {
        return {
          cellId: status.cellId,
          admissionState: status.admissionState,
          assignments: integer(status.assignments, 'assignments'),
          hardCap: runtime === null ? null : status.connectionCapacity?.hardCap ?? null,
          unobservedBound:
            runtime === null ? null : status.connectionCapacity?.unobservedBound ?? null,
          heartbeatFresh:
            status.connectionCapacity?.heartbeatFresh ?? status.runtime?.heartbeatFresh ?? false,
          imageDigest: runtime?.imageDigest ?? null,
          ...(config.activity === 'restart-safe'
            ? { restartBlockingReservedRequests }
            : {})
        }
      }
      restartSafeSamples = matches ? 1 : 0
    } else {
      restartSafeSamples = 0
    }
    if (config.activity === 'restart-safe') {
      lastObservation = {
        ...lastObservation,
        restartSafeSamples,
        requiredRestartSafeSamples: 2
      }
    }
    if (now() >= deadline) {
      throw new Error(
        `capacity transition verification timed out: ${JSON.stringify(lastObservation)}`
      )
    }
    await wait(5_000)
  }
}

export async function main(argv = process.argv.slice(2)) {
  const result = await verifyCapacityTransition(parseCapacityTransitionArguments(argv))
  process.stdout.write(`${JSON.stringify({ event: 'relay_capacity_transition_verified', ...result })}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
