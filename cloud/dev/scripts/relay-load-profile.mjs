export const RELAY_CONTROL_LEASE_HORIZON_SECONDS = 105
export const RELAY_LOAD_SPLICE_HIGH_WATER_BYTES = 256 * 1024
export const RELAY_LOAD_SPLICE_WEDGED_TIMEOUT_MS = 10_000
export const RELAY_LOAD_MAX_AGGREGATE_READER_SPLICES = 16
export const RELAY_LOAD_MAX_AGGREGATE_READER_BYTES = 64 * 1024 * 1024

const DEFAULT_SLOW_READER_STREAM_BYTES = 1024 * 1024
const DEFAULT_WEDGED_READER_STREAM_BYTES = 8 * 1024 * 1024
const DEFAULT_READER_FRAME_BYTES = 64 * 1024

export function parseRelayLoadArguments(argv) {
  const values = new Map()
  const flags = new Set()
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--') continue
    if (
      [
        '--allow-partial',
        '--allow-planned-transition-retries',
        '--skip-rebind-overflow-check'
      ].includes(argument)
    ) {
      flags.add(argument)
      continue
    }
    if (!argument.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(`invalid argument: ${argument}`)
    }
    values.set(argument, argv[++index])
  }
  const integer = (name, fallback) => {
    const parsed = Number(values.get(name) ?? fallback)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`${name} must be a nonnegative integer`)
    }
    return parsed
  }
  const targetOrigin = values.get('--target-origin')?.replace(/\/$/, '')
  const directorOrigin = values.get('--director-origin')?.replace(/\/$/, '')
  const authOrigin = values.get('--auth-origin')?.replace(/\/$/, '')
  if ((!targetOrigin && !directorOrigin) || (targetOrigin && directorOrigin) || !authOrigin) {
    throw new Error('provide --auth-origin and exactly one target or director origin')
  }
  const controls = integer('--controls', 100)
  const maxRampConnectionFailures = integer('--max-ramp-connection-failures', 0)
  const maxUnexpectedCloses = integer('--max-unexpected-closes', 0)
  const rebindProbes = integer('--rebind-probes', 0)
  const placementOverflowProbes = integer('--placement-overflow-probes', 0)
  const regionalFallbackProbes = integer('--regional-fallback-probes', 0)
  const regionBehaviorProbes = integer('--region-behavior-probes', 0)
  const requestUnitInvites = integer('--request-unit-invites', 0)
  const requestUnitInvitesPerSecond = integer('--request-unit-invites-per-second', 0)
  const requestUnitPrincipalCount = integer('--request-unit-principals', 0)
  const relayAsiaLoadPrincipalCount = integer('--relay-asia-load-principals', 0)
  const requestUnitOverflowProbes = integer('--request-unit-overflow-probes', 0)
  const requestUnitCapacity = values.has('--request-unit-capacity')
    ? integer('--request-unit-capacity', 0)
    : undefined
  const requestUnitCleanupTimeoutMs = integer(
    '--request-unit-cleanup-timeout-seconds',
    0
  ) * 1000
  const rebindHoldMs = integer('--rebind-hold-ms', 4_000)
  const rebindDelayMs = integer('--rebind-delay-seconds', 0) * 1000
  const capacityCellId = values.get('--capacity-cell-id')
  const capacityCellOrigin = values.get('--capacity-cell-origin')?.replace(/\/$/, '')
  const capacityHardCap = values.has('--capacity-hard-cap')
    ? integer('--capacity-hard-cap', 0)
    : undefined
  const capacityUnobservedBound = values.has('--capacity-unobserved-bound')
    ? integer('--capacity-unobserved-bound', 0)
    : undefined
  const shardCount = integer('--shard-count', 1)
  const shardIndex = integer('--shard-index', 0)
  const durationMs = integer('--duration-seconds', 900) * 1000
  const spliceHoldMs = integer(
    '--splice-hold-seconds',
    values.get('--duration-seconds') ?? 900
  ) * 1000
  const splices = integer('--splices', 0)
  const spliceRampMs = integer('--splice-ramp-seconds', 0) * 1000
  const slowReaderSplices = integer('--slow-reader-splices', 0)
  const wedgedReaderSplices = integer('--wedged-reader-splices', 0)
  const splicePayloadBytes = integer('--splice-payload-bytes', 1_024)
  const slowReaderStreamBytes = integer(
    '--slow-reader-stream-bytes',
    DEFAULT_SLOW_READER_STREAM_BYTES
  )
  const wedgedReaderStreamBytes = integer(
    '--wedged-reader-stream-bytes',
    DEFAULT_WEDGED_READER_STREAM_BYTES
  )
  const readerFrameBytes = integer('--reader-frame-bytes', DEFAULT_READER_FRAME_BYTES)
  const slowReaderHoldMs = integer('--slow-reader-hold-ms', 2_000)
  const wedgedReaderHoldMs = integer('--wedged-reader-hold-ms', 12_000)
  const maxGeneratorRssGrowthMiB = integer('--max-generator-rss-growth-mib', 512)
  const requiredLeaseHorizons = integer('--required-lease-horizons', 0)
  const aggregateControls = values.has('--aggregate-controls')
    ? integer('--aggregate-controls', 0)
    : controls
  const aggregateSplices = values.has('--aggregate-splices')
    ? integer('--aggregate-splices', 0)
    : splices
  const aggregateRequestUnitInvites = values.has('--aggregate-request-unit-invites')
    ? integer('--aggregate-request-unit-invites', 0)
    : requestUnitInvites
  const phaseBarrierDir = values.get('--phase-barrier-dir')
  const phaseBarrierTimeoutMs = integer('--phase-barrier-timeout-seconds', 180) * 1000
  if (controls < 1 || controls > 10_000) throw new Error('--controls must be between 1 and 10000')
  if (rebindProbes > controls) throw new Error('--rebind-probes cannot exceed --controls')
  if (splices > controls) throw new Error('--splices cannot exceed --controls')
  if (shardCount > 1 && capacityHardCap !== undefined) {
    if (!values.has('--aggregate-controls') || !values.has('--aggregate-splices')) {
      throw new Error('capacity-bound sharding requires explicit aggregate controls and splices')
    }
    if (aggregateControls !== controls * shardCount || aggregateSplices !== splices * shardCount) {
      throw new Error('aggregate controls and splices must match every equal-sized shard')
    }
  } else if (aggregateControls !== controls || aggregateSplices !== splices) {
    throw new Error('aggregate controls and splices require matching sharded local counts')
  }
  if (
    capacityHardCap !== undefined &&
    aggregateControls + 2 * aggregateSplices > capacityHardCap - 100
  ) {
    throw new Error('controls plus splice connection units exceed ordinary cell admission')
  }
  if (slowReaderSplices + wedgedReaderSplices > splices) {
    throw new Error('reader splice counts cannot exceed --splices')
  }
  if (splices > 0 && (spliceHoldMs < 1_000 || spliceHoldMs > durationMs)) {
    throw new Error('--splice-hold-seconds must be between 1 and the steady duration')
  }
  if (slowReaderSplices + wedgedReaderSplices > 0 && !directorOrigin) {
    throw new Error('reader evidence requires --director-origin')
  }
  if (splicePayloadBytes < 1 || splicePayloadBytes > 1_048_576) {
    throw new Error('--splice-payload-bytes must be between 1 and 1048576')
  }
  if (
    slowReaderSplices > 0 &&
    slowReaderStreamBytes <= RELAY_LOAD_SPLICE_HIGH_WATER_BYTES
  ) {
    throw new Error('--slow-reader-stream-bytes must exceed the 256 KiB splice high-water mark')
  }
  if (
    wedgedReaderSplices > 0 &&
    wedgedReaderStreamBytes <= RELAY_LOAD_SPLICE_HIGH_WATER_BYTES
  ) {
    throw new Error('--wedged-reader-stream-bytes must exceed the 256 KiB splice high-water mark')
  }
  const localReaderSplices = slowReaderSplices + wedgedReaderSplices
  const localReaderBytes = slowReaderSplices * slowReaderStreamBytes +
    wedgedReaderSplices * wedgedReaderStreamBytes
  const aggregateReaderSplices = values.has('--aggregate-reader-splices')
    ? integer('--aggregate-reader-splices', 0)
    : localReaderSplices * shardCount
  const aggregateReaderBytes = values.has('--aggregate-reader-bytes')
    ? integer('--aggregate-reader-bytes', 0)
    : localReaderBytes * shardCount
  if (
    aggregateReaderSplices < localReaderSplices ||
    aggregateReaderBytes < localReaderBytes ||
    (shardCount === 1 &&
      (aggregateReaderSplices !== localReaderSplices || aggregateReaderBytes !== localReaderBytes))
  ) {
    throw new Error('aggregate reader bounds do not cover the local shard')
  }
  if (aggregateReaderSplices > RELAY_LOAD_MAX_AGGREGATE_READER_SPLICES) {
    throw new Error('aggregate reader splice count exceeds the reviewed bound')
  }
  if (aggregateReaderBytes > RELAY_LOAD_MAX_AGGREGATE_READER_BYTES) {
    throw new Error('aggregate reader stream bytes exceed the reviewed bound')
  }
  if (readerFrameBytes < 1 || readerFrameBytes > 1_048_576) {
    throw new Error('--reader-frame-bytes must be between 1 and 1048576')
  }
  if (slowReaderSplices > 0 && slowReaderHoldMs >= RELAY_LOAD_SPLICE_WEDGED_TIMEOUT_MS) {
    throw new Error('--slow-reader-hold-ms must stay below the wedged timeout')
  }
  if (wedgedReaderSplices > 0 && wedgedReaderHoldMs <= RELAY_LOAD_SPLICE_WEDGED_TIMEOUT_MS) {
    throw new Error('--wedged-reader-hold-ms must exceed the wedged timeout')
  }
  if (wedgedReaderHoldMs > 30_000) {
    throw new Error('--wedged-reader-hold-ms cannot exceed 30000')
  }
  if (maxGeneratorRssGrowthMiB < 1) {
    throw new Error('--max-generator-rss-growth-mib must be positive')
  }
  if (placementOverflowProbes > 1) {
    throw new Error('--placement-overflow-probes must be zero or one')
  }
  if (regionalFallbackProbes > 1) {
    throw new Error('--regional-fallback-probes must be zero or one')
  }
  if (regionBehaviorProbes > 1 || requestUnitOverflowProbes > 1) {
    throw new Error('regional behavior and request-unit overflow probes must be zero or one')
  }
  if (placementOverflowProbes > 0 && shardCount > 1) {
    throw new Error('placement overflow proof requires one coordinated generator')
  }
  if (
    placementOverflowProbes > 0 &&
    (!directorOrigin ||
      !capacityCellId ||
      capacityHardCap === undefined ||
      capacityUnobservedBound === undefined)
  ) {
    throw new Error('placement overflow requires exact capacity cell, hard cap, and bound')
  }
  if (regionalFallbackProbes > 0 && (
    !directorOrigin || !capacityCellId || !capacityCellOrigin ||
    capacityHardCap === undefined || capacityUnobservedBound === undefined ||
    (shardCount > 1 && shardIndex !== 0)
  )) throw new Error('regional fallback requires the coordinating capacity shard')
  if (regionBehaviorProbes > 0 && (
    !directorOrigin || !capacityCellOrigin || preferredRegionValue(values) !== 'asia-east2' ||
    (shardCount > 1 && shardIndex !== 0)
  )) throw new Error('regional behavior proof requires the coordinating Asia shard')
  if (phaseBarrierDir && shardCount < 2) {
    throw new Error('phase barrier requires multiple shards')
  }
  if (phaseBarrierTimeoutMs < 1_000) {
    throw new Error('phase barrier timeout must be at least one second')
  }
  if (requestUnitInvites > 0) {
    if (
      !directorOrigin || !capacityCellId || requestUnitCapacity === undefined ||
      requestUnitCapacity < 1 || requestUnitInvitesPerSecond < 1 ||
      requestUnitInvitesPerSecond > 20 || requestUnitPrincipalCount < 1 ||
      requestUnitPrincipalCount > 32 || requestUnitInvites > requestUnitPrincipalCount * 30 ||
      aggregateSplices !== 0 || !phaseBarrierDir ||
      aggregateRequestUnitInvites !== requestUnitInvites * shardCount ||
      aggregateControls + aggregateRequestUnitInvites !== requestUnitCapacity
    ) throw new Error('request-unit proof does not reach the exact reviewed capacity')
  } else if (
    requestUnitCapacity !== undefined || requestUnitInvitesPerSecond !== 0 ||
    requestUnitPrincipalCount !== 0 ||
    requestUnitOverflowProbes > 0 ||
    requestUnitCleanupTimeoutMs > 0 || aggregateRequestUnitInvites !== 0
  ) throw new Error('request-unit proof options require invite offers')
  if (
    requestUnitOverflowProbes > 0 &&
    (shardIndex !== 0 || requestUnitCleanupTimeoutMs < 600_000)
  ) throw new Error('request-unit overflow requires the cleanup-owning coordinator')
  if (requestUnitCleanupTimeoutMs > 0 && requestUnitOverflowProbes !== 1) {
    throw new Error('request-unit cleanup requires the overflow proof')
  }
  if (
    relayAsiaLoadPrincipalCount > 32 ||
    (relayAsiaLoadPrincipalCount > 0 &&
      (!directorOrigin || preferredRegionValue(values) !== 'asia-east2'))
  ) throw new Error('Relay Asia load principals require a regional director proof')
  if (capacityCellOrigin) {
    const origin = new URL(capacityCellOrigin)
    if (origin.protocol !== 'https:' || origin.origin !== capacityCellOrigin) {
      throw new Error('--capacity-cell-origin must be canonical HTTPS')
    }
  }
  if (shardCount < 1 || shardIndex >= shardCount) throw new Error('invalid shard index/count')
  const minimumDurationMs = requiredLeaseHorizons * RELAY_CONTROL_LEASE_HORIZON_SECONDS * 1000
  if (durationMs < minimumDurationMs) {
    throw new Error(`--duration-seconds must cover ${requiredLeaseHorizons} lease horizons`)
  }
  return {
    targetOrigin,
    directorOrigin,
    authOrigin,
    preferredRegion: preferredRegionValue(values),
    controls,
    maxRampConnectionFailures,
    maxUnexpectedCloses,
    rebindProbes,
    placementOverflowProbes,
    regionalFallbackProbes,
    regionBehaviorProbes,
    requestUnitInvites,
    requestUnitInvitesPerSecond,
    requestUnitPrincipalCount,
    relayAsiaLoadPrincipalCount,
    requestUnitOverflowProbes,
    requestUnitCapacity,
    requestUnitCleanupTimeoutMs,
    rebindHoldMs,
    rebindDelayMs,
    capacityCellId,
    capacityCellOrigin,
    capacityHardCap,
    capacityUnobservedBound,
    durationMs,
    spliceHoldMs,
    rampMs: integer('--ramp-seconds', 60) * 1000,
    rampStartDelayMs: integer('--ramp-start-delay-ms', 0),
    reconnectMaxMs: integer('--reconnect-max-seconds', 30) * 1000,
    shardCount,
    shardIndex,
    aggregateControls,
    aggregateSplices,
    aggregateRequestUnitInvites,
    phaseBarrierDir,
    phaseBarrierTimeoutMs,
    aggregateReaderSplices,
    aggregateReaderBytes,
    signingKeyFile: values.get('--signing-key-file'),
    splices,
    spliceRampMs,
    splicePayloadBytes,
    slowReaderSplices,
    wedgedReaderSplices,
    slowReaderStreamBytes,
    wedgedReaderStreamBytes,
    readerFrameBytes,
    slowReaderHoldMs,
    wedgedReaderHoldMs,
    maxGeneratorRssGrowthMiB,
    requiredLeaseHorizons,
    allowPartial: flags.has('--allow-partial'),
    allowPlannedTransitionRetries: flags.has('--allow-planned-transition-retries'),
    requireRebindOverflow: !flags.has('--skip-rebind-overflow-check')
  }
}

function preferredRegionValue(values) {
  return values.get('--preferred-region')
}

export function relayLoadSpliceIndexes(config) {
  return Array.from(
    { length: config.splices },
    (_, localIndex) => localIndex * config.shardCount + config.shardIndex
  )
}

export function relayLoadSpliceStartDelayMs(config, localIndex) {
  if (!Number.isSafeInteger(localIndex) || localIndex < 0 || localIndex >= config.splices) {
    throw new Error('invalid local splice index')
  }
  const totalSplices = config.splices * config.shardCount
  if (totalSplices <= 1) return 0
  const globalOrdinal = localIndex * config.shardCount + config.shardIndex
  return Math.floor(globalOrdinal * config.spliceRampMs / (totalSplices - 1))
}

export function relayLoadPrincipalIndex(peerIndex, shardCount, principalCount) {
  if (
    !Number.isSafeInteger(peerIndex) || peerIndex < 0 ||
    !Number.isSafeInteger(shardCount) || shardCount < 1 ||
    !Number.isSafeInteger(principalCount) || principalCount < 1
  ) throw new Error('invalid Relay load principal mapping')
  return Math.floor(peerIndex / shardCount) % principalCount
}

export function relayLoadSpliceProfile(config, spliceIndex) {
  if (spliceIndex < config.wedgedReaderSplices) {
    return {
      readerMode: 'wedged',
      readerHoldMs: config.wedgedReaderHoldMs,
      streamBytes: config.wedgedReaderStreamBytes,
      frameBytes: config.readerFrameBytes
    }
  }
  if (spliceIndex < config.wedgedReaderSplices + config.slowReaderSplices) {
    return {
      readerMode: 'slow',
      readerHoldMs: config.slowReaderHoldMs,
      streamBytes: config.slowReaderStreamBytes,
      frameBytes: config.readerFrameBytes
    }
  }
  return {
    readerMode: 'normal',
    readerHoldMs: 0,
    streamBytes: config.splicePayloadBytes,
    frameBytes: config.splicePayloadBytes
  }
}

export function relayLoadReaderEvidenceError(result, config) {
  const readerSplices = config.slowReaderSplices + config.wedgedReaderSplices
  if (readerSplices > 0 && result.generatorRssGrowthMiB > config.maxGeneratorRssGrowthMiB) {
    return 'load generator exceeded its RSS growth budget'
  }
  if (result.slowReaderSplicesCompleted !== config.slowReaderSplices) {
    return 'slow-reader streams did not all complete'
  }
  if (result.wedgedReaderSplicesClosed !== config.wedgedReaderSplices) {
    return 'wedged-reader streams did not all close at the relay limit'
  }
  if (
    readerSplices > 0 &&
    (result.readerQueueEvidence.length === 0 ||
      result.readerQueueEvidence.some(({ increaseBytes }) => increaseBytes < 1))
  ) {
    return 'reader streams produced no causal Relay queued-byte evidence'
  }
  if (
    config.wedgedReaderSplices > 0 &&
    result.readerClosesByCode['4429'] !== config.wedgedReaderSplices
  ) {
    return 'wedged-reader streams did not close with 4429'
  }
  return undefined
}
