import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { RelayLoadControlPeer } from './relay-load-control-peer.mjs'
import { requestGitHubSmokeTokens } from './github-smoke-token.mjs'
import { relayLoadFailureReason } from './relay-load-connection-failure.mjs'
import {
  assertRelayLoadDirectorCapacityToken,
  waitForRelayLoadDirectorCapacity,
  waitForRelayLoadRequestUnits
} from './relay-load-director-capacity-gate.mjs'
import { waitForRelayLoadPhaseBarrier } from './relay-load-phase-barrier.mjs'
import {
  proveRelayLoadPlacementBoundary,
  proveRelayLoadRegionalFallback
} from './relay-load-placement-boundary.mjs'
import {
  proveRelayLoadRebindBoundary,
  waitForRelayLoadRebindGate
} from './relay-load-rebind-boundary.mjs'
import { proveRelayLoadRegionBehavior } from './relay-load-region-behavior.mjs'
import {
  openRelayLoadInviteOffers,
  proveRelayLoadRequestUnitBoundary
} from './relay-load-request-unit-boundary.mjs'
import {
  assertRelayLoadRampAccepted,
  relayLoadRunHasDisallowedFailures,
  runRelayLoadWithShutdown
} from './relay-load-run-lifecycle.mjs'
import { createRelayLoadReaderEvidence } from './relay-load-reader-evidence.mjs'
import {
  parseRelayLoadArguments,
  relayLoadPrincipalIndex,
  relayLoadReaderEvidenceError,
  relayLoadSpliceIndexes,
  relayLoadSpliceProfile,
  relayLoadSpliceStartDelayMs
} from './relay-load-profile.mjs'

function signingKey(path) {
  if (!path) return {}
  const key = createPrivateKey(readFileSync(path, 'utf8'))
  const signingKeyId = createHash('sha256')
    .update(createPublicKey(key).export({ type: 'spki', format: 'der' }))
    .digest('base64url')
    .slice(0, 16)
  return { signingKey: key, signingKeyId }
}

function report(state, final = false) {
  const elapsedSeconds = Math.max(1, (Date.now() - state.startedAt) / 1000)
  const memory = process.memoryUsage()
  const cpu = process.cpuUsage(state.generatorBaselineCpu)
  const rssMiB = memory.rss / 1_048_576
  state.generatorPeakRssMiB = Math.max(state.generatorPeakRssMiB, rssMiB)
  const readerQueueEvidence = state.readerEvidence?.snapshot() ?? []
  const output = {
    event: final ? 'relay_load_complete' : 'relay_load_progress',
    controls: state.controls,
    shardCount: state.shardCount,
    shardIndex: state.shardIndex,
    configuredRampSeconds: state.rampMs / 1000,
    configuredSteadySeconds: state.durationMs / 1000,
    configuredSpliceHoldSeconds: state.spliceHoldMs / 1000,
    requiredLeaseHorizons: state.requiredLeaseHorizons,
    configuredSplices: state.splices,
    configuredSlowReaderSplices: state.slowReaderSplices,
    configuredWedgedReaderSplices: state.wedgedReaderSplices,
    active: state.active.size,
    peakActive: state.peakActive,
    steadyMinimumActive: state.steadyMinimumActive,
    connected: state.connected,
    connectionFailures: state.connectionFailures,
    rampConnectionFailures: state.rampConnectionFailures,
    steadyConnectionFailures: state.steadyConnectionFailures,
    transitionConnectionFailures: state.transitionConnectionFailures,
    connectionFailuresByReason: state.connectionFailuresByReason,
    closes: state.closes,
    unexpectedCloses: state.unexpectedCloses,
    unexpectedClosesByCode: state.unexpectedClosesByCode,
    drains: state.drains,
    pings: state.pings,
    pingRate: Number((state.pings / elapsedSeconds).toFixed(2)),
    tokens: state.tokens,
    tokenRate: Number((state.tokens / elapsedSeconds).toFixed(2)),
    refreshes: state.refreshes,
    refreshErrors: state.refreshErrors,
    protocolErrors: state.protocolErrors,
    socketErrors: state.socketErrors,
    rebindProbesOpened: state.rebindProbesOpened,
    rebindOverflowReason: state.rebindOverflowReason,
    placementOverflowReason: state.placementOverflowReason,
    regionalFallbacksProved: state.regionalFallbacksProved,
    oldClientUsFirstProved: state.oldClientUsFirstProved,
    stickyAssignmentProved: state.stickyAssignmentProved,
    requestUnitInvitesOpened: state.requestUnitInvitesOpened,
    requestUnitPrincipalCount: state.requestUnitPrincipalCount,
    relayAsiaLoadPrincipalCount: state.relayAsiaLoadPrincipalCount,
    requestUnitOverflowReason: state.requestUnitOverflowReason,
    requestUnitCleanupProved: state.requestUnitCleanupProved,
    phaseBarrierPassed: state.phaseBarrierPassed,
    activeSplices: state.activeSplices,
    peakActiveSplices: state.peakActiveSplices,
    completedSplices: state.completedSplices,
    failedSplices: state.failedSplices,
    slowReaderSplicesCompleted: state.slowReaderSplicesCompleted,
    wedgedReaderSplicesClosed: state.wedgedReaderSplicesClosed,
    readerQueueEvidence,
    readerQueuedBytesPeak: Math.max(
      0,
      ...readerQueueEvidence.map(({ increaseBytes }) => increaseBytes)
    ),
    readerClosesByCode: state.readerClosesByCode,
    controlHeadroom: Math.max(0, state.controls - state.active.size),
    generatorRssMiB: Number(rssMiB.toFixed(1)),
    generatorPeakRssMiB: Number(state.generatorPeakRssMiB.toFixed(1)),
    generatorRssGrowthMiB: Number(
      Math.max(0, state.generatorPeakRssMiB - state.generatorBaselineRssMiB).toFixed(1)
    ),
    generatorHeapUsedMiB: Number((memory.heapUsed / 1_048_576).toFixed(1)),
    generatorCpuPercent: Number(
      (((cpu.user + cpu.system) / 1_000_000 / elapsedSeconds) * 100).toFixed(1)
    ),
    generatorEventLoopP99Ms: Number((state.eventLoopDelay.percentile(99) / 1_000_000).toFixed(2)),
    shutdownEvidence: final ? state.shutdownEvidence : undefined,
    elapsedSeconds: Number(elapsedSeconds.toFixed(1))
  }
  console.log(JSON.stringify(output))
  return output
}

const config = parseRelayLoadArguments(process.argv.slice(2))
let accessToken = process.env.ORCA_RELAY_LOAD_ACCESS_TOKEN
let accessTokenProviderForIndex
const adminToken = process.env.ORCA_RELAY_ADMIN_ID_TOKEN
if (
  config.placementOverflowProbes > 0 || config.regionalFallbackProbes > 0 ||
  config.slowReaderSplices + config.wedgedReaderSplices > 0 ||
  config.requestUnitOverflowProbes > 0 || config.requestUnitCleanupTimeoutMs > 0
) {
  assertRelayLoadDirectorCapacityToken({
    directorOrigin: config.directorOrigin,
    adminToken
  }, Date.now,
  config.rampMs + config.durationMs + config.wedgedReaderHoldMs +
    (config.phaseBarrierDir ? 2 * config.phaseBarrierTimeoutMs : 0) +
    config.spliceRampMs + config.requestUnitCleanupTimeoutMs + 120_000)
}
const key = signingKey(config.signingKeyFile)
if (!accessToken && !key.signingKey && process.env.ACTIONS_ID_TOKEN_REQUEST_URL &&
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
  let tokens
  let refresh
  const loadOptions = config.relayAsiaLoadPrincipalCount > 0
    ? {
        relayAsiaLoad: {
          shardIndex: config.shardIndex,
          principalCount: config.relayAsiaLoadPrincipalCount
        }
      }
    : undefined
  const smokeTokens = async () => {
    const expiresAt = config.relayAsiaLoadPrincipalCount > 0
      ? tokens?.relayAsiaLoadPrincipals?.[0]?.expiresAt
      : tokens?.owner?.expiresAt
    if (expiresAt > Date.now() + 60_000) return tokens
    refresh ??= requestGitHubSmokeTokens(
      config.authOrigin,
      fetch,
      process.env,
      loadOptions
    )
    try {
      tokens = await refresh
      return tokens
    } finally {
      refresh = undefined
    }
  }
  accessTokenProviderForIndex = (index) => async () => {
    const current = await smokeTokens()
    return config.relayAsiaLoadPrincipalCount > 0
      ? current.relayAsiaLoadPrincipals[
          relayLoadPrincipalIndex(
            index,
            config.shardCount,
            current.relayAsiaLoadPrincipals.length
          )
        ].accessToken
      : current.owner.accessToken
  }
  await smokeTokens()
}
if (!accessToken && !accessTokenProviderForIndex && !key.signingKey) {
  throw new Error('provide GitHub OIDC, ORCA_RELAY_LOAD_ACCESS_TOKEN, or --signing-key-file')
}
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
eventLoopDelay.enable()
const generatorBaselineRssMiB = process.memoryUsage().rss / 1_048_576
const generatorBaselineCpu = process.cpuUsage()
const state = {
  ...config,
  startedAt: Date.now(),
  active: new Set(),
  peakActive: 0,
  steadyMinimumActive: null,
  steadyStarted: false,
  connected: 0,
  connectionFailures: 0,
  rampConnectionFailures: 0,
  steadyConnectionFailures: 0,
  transitionConnectionFailures: 0,
  connectionFailuresByReason: {},
  closes: 0,
  unexpectedCloses: 0,
  unexpectedClosesByCode: {},
  drains: 0,
  pings: 0,
  tokens: 0,
  refreshes: 0,
  refreshErrors: 0,
  protocolErrors: 0,
  socketErrors: 0,
  rebindProbesOpened: 0,
  rebindOverflowReason: null,
  placementOverflowReason: null,
  regionalFallbacksProved: 0,
  oldClientUsFirstProved: 0,
  stickyAssignmentProved: 0,
  requestUnitInvitesOpened: 0,
  requestUnitOverflowReason: null,
  requestUnitCleanupProved: 0,
  phaseBarrierPassed: false,
  activeSplices: 0,
  peakActiveSplices: 0,
  completedSplices: 0,
  failedSplices: 0,
  slowReaderSplicesCompleted: 0,
  wedgedReaderSplicesClosed: 0,
  readerEvidence: null,
  readerClosesByCode: {},
  generatorBaselineRssMiB,
  generatorBaselineCpu,
  generatorPeakRssMiB: generatorBaselineRssMiB,
  peerShutdowns: 0,
  shutdownEvidence: null,
  eventLoopDelay,
  stopping: false,
  transitionWindow: false
}
const peers = new Map()
const reconnectTimers = new Set()

async function readRuntimeQueuedBytes(origin) {
  const response = await fetch(`${origin}/v1/admin/runtime-status`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1 }),
    signal: AbortSignal.timeout(5_000)
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error('reader evidence identity was rejected')
  }
  if (!response.ok) throw new Error(`reader runtime status returned ${response.status}`)
  const status = await response.json()
  const queuedBytes = status?.runtime?.queuedBytes
  if (!Number.isSafeInteger(queuedBytes) || queuedBytes < 0) {
    throw new Error('reader runtime queued bytes are invalid')
  }
  return queuedBytes
}

async function observeReaderPressure(input) {
  if (!state.readerEvidence) throw new Error('reader evidence baseline is unavailable')
  await state.readerEvidence.observe(input)
  state.generatorPeakRssMiB = Math.max(
    state.generatorPeakRssMiB,
    process.memoryUsage().rss / 1_048_576
  )
}

function recordSteadyMinimum() {
  if (!state.steadyStarted || state.stopping) return
  state.steadyMinimumActive = Math.min(state.steadyMinimumActive, state.active.size)
}

function scheduleReconnect(peer) {
  if (state.stopping) return
  const timeout = setTimeout(() => {
    reconnectTimers.delete(timeout)
    void connect(peer)
  }, Math.floor(Math.random() * (config.reconnectMaxMs + 1)))
  reconnectTimers.add(timeout)
}

function observe(type, detail) {
  if (type === 'connected') {
    state.active.add(detail.index)
    state.connected++
    state.peakActive = Math.max(state.peakActive, state.active.size)
    recordSteadyMinimum()
  } else if (type === 'closed') {
    state.active.delete(detail.index)
    state.closes++
    if (!detail.stopped && !detail.expectedDrain) {
      state.unexpectedCloses++
      const code = String(detail.code)
      state.unexpectedClosesByCode[code] = (state.unexpectedClosesByCode[code] ?? 0) + 1
    }
    if (!detail.stopped) scheduleReconnect(peers.get(detail.index))
    recordSteadyMinimum()
  } else if (type === 'drain') state.drains++
  else if (type === 'ping') state.pings++
  else if (type === 'token') state.tokens++
  else if (type === 'refresh') state.refreshes++
  else if (type === 'refreshError') state.refreshErrors++
  else if (type === 'protocolError') state.protocolErrors++
  else if (type === 'socketError') state.socketErrors++
  else if (type === 'spliceOpened') {
    state.activeSplices++
    state.peakActiveSplices = Math.max(state.peakActiveSplices, state.activeSplices)
  } else if (type === 'spliceCompleted') {
    state.completedSplices++
    if (detail.readerMode === 'slow') state.slowReaderSplicesCompleted++
  } else if (type === 'spliceWedged') {
    state.wedgedReaderSplicesClosed++
    const code = String(detail.code)
    state.readerClosesByCode[code] = (state.readerClosesByCode[code] ?? 0) + 1
  } else if (type === 'spliceClosed') state.activeSplices--
  else if (type === 'spliceFailed') state.failedSplices++
  else if (type === 'shutdown') state.peerShutdowns++
}

async function connect(peer) {
  try {
    await peer.connect()
  } catch (error) {
    state.connectionFailures++
    if (state.steadyStarted) state.steadyConnectionFailures++
    else if (state.transitionWindow) state.transitionConnectionFailures++
    else state.rampConnectionFailures++
    const reason = relayLoadFailureReason(error)
    state.connectionFailuresByReason[reason] =
      (state.connectionFailuresByReason[reason] ?? 0) + 1
    scheduleReconnect(peer)
  }
}

const peerOptions = (index, overrides = {}) => ({
  ...config,
  ...key,
  accessToken,
  ...(accessTokenProviderForIndex
    ? { accessTokenProvider: accessTokenProviderForIndex(index) }
    : {}),
  seed: 0x4f524341 ^ config.shardIndex,
  ...overrides
})
if (config.regionBehaviorProbes > 0) {
  const proofIndex = config.controls * config.shardCount + 10_000
  const regionProof = await proveRelayLoadRegionBehavior({
    oldClientPeer: new RelayLoadControlPeer(
      proofIndex,
      peerOptions(proofIndex, { preferredRegion: undefined }),
      () => undefined
    ),
    stickyPeer: new RelayLoadControlPeer(
      proofIndex + 1,
      peerOptions(proofIndex + 1, { preferredRegion: 'asia-east2' }),
      () => undefined
    ),
    asiaOrigin: config.capacityCellOrigin
  })
  state.oldClientUsFirstProved = regionProof.oldClientUsFirst ? 1 : 0
  state.stickyAssignmentProved = regionProof.stickyAssignmentPreserved ? 1 : 0
}
const initialConnections = []
for (let localIndex = 0; localIndex < config.controls; localIndex++) {
  const globalIndex = localIndex * config.shardCount + config.shardIndex
  const peer = new RelayLoadControlPeer(globalIndex, peerOptions(globalIndex), observe)
  peers.set(globalIndex, peer)
  const rampOffset =
    config.controls === 1 ? 0 : Math.floor((localIndex / (config.controls - 1)) * config.rampMs)
  const offset = config.rampStartDelayMs + rampOffset
  initialConnections.push(delay(offset).then(() => connect(peer)))
}
const progressTimer = setInterval(() => report(state), 10_000)
progressTimer.unref()
await runRelayLoadWithShutdown(async () => {
  await Promise.all(initialConnections)
  assertRelayLoadRampAccepted(state.rampConnectionFailures, config.maxRampConnectionFailures)
  if (
    config.rebindProbes > 0 || config.placementOverflowProbes > 0 ||
    config.regionalFallbackProbes > 0
  ) {
    state.transitionWindow = config.rebindDelayMs > 0
    await waitForRelayLoadRebindGate({
      delay,
      delayMs: config.rebindDelayMs,
      activeCount: () => state.active.size,
      requiredCount: config.controls
    })
    state.transitionWindow = false
  }
  if (config.placementOverflowProbes > 0 || config.regionalFallbackProbes > 0) {
    const closesBeforeBoundary = state.closes
    await waitForRelayLoadDirectorCapacity({
      directorOrigin: config.directorOrigin,
      adminToken,
      cellId: config.capacityCellId,
      hardCap: config.capacityHardCap,
      unobservedBound: config.capacityUnobservedBound,
      requiredConnections: config.aggregateControls
    })
    if (state.active.size !== config.controls || state.closes !== closesBeforeBoundary) {
      throw new Error('ordinary controls changed during the director capacity gate')
    }
    const overflowIndex = config.controls * config.shardCount + config.shardIndex
    if (config.placementOverflowProbes > 0) {
      state.placementOverflowReason = await proveRelayLoadPlacementBoundary({
        peer: new RelayLoadControlPeer(overflowIndex, peerOptions(overflowIndex), observe),
        failureReason: relayLoadFailureReason
      })
    }
    if (config.regionalFallbackProbes > 0) {
      await proveRelayLoadRegionalFallback({
        peer: new RelayLoadControlPeer(overflowIndex, peerOptions(overflowIndex), () => undefined),
        blockedOrigin: config.capacityCellOrigin
      })
      state.regionalFallbacksProved = 1
    }
    if (state.active.size !== config.controls || state.closes !== closesBeforeBoundary) {
      throw new Error('ordinary controls changed during the placement boundary probe')
    }
    await waitForRelayLoadDirectorCapacity({
      directorOrigin: config.directorOrigin,
      adminToken,
      cellId: config.capacityCellId,
      hardCap: config.capacityHardCap,
      unobservedBound: config.capacityUnobservedBound,
      requiredConnections: config.aggregateControls,
      requiredSamples: 1
    })
    if (state.active.size !== config.controls || state.closes !== closesBeforeBoundary) {
      throw new Error('ordinary controls changed before post-probe capacity verification')
    }
  }
  const rebindResult = await proveRelayLoadRebindBoundary({
    peers: [...state.active].map((index) => peers.get(index)),
    probeCount: config.rebindProbes,
    holdMs: config.rebindHoldMs,
    delay,
    failureReason: relayLoadFailureReason,
    requireOverflow: config.requireRebindOverflow
  })
  state.rebindProbesOpened = rebindResult.opened
  state.rebindOverflowReason = rebindResult.overflowReason
  if (config.requestUnitInvites > 0) {
    state.requestUnitInvitesOpened = await openRelayLoadInviteOffers({
      peers: [...state.active].sort((left, right) => left - right).map((index) => peers.get(index)),
      count: config.requestUnitInvites,
      ratePerSecond: config.requestUnitInvitesPerSecond
    })
  }
  if (config.requestUnitOverflowProbes > 0) {
    await waitForRelayLoadRequestUnits({
      directorOrigin: config.directorOrigin,
      adminToken,
      cellId: config.capacityCellId,
      capacityRequests: config.requestUnitCapacity,
      expectedRequestUnits: config.requestUnitCapacity,
      expectedActivityLeases: config.requestUnitCapacity
    })
    state.requestUnitOverflowReason = await proveRelayLoadRequestUnitBoundary(
      peers.get([...state.active][0])
    )
  }
  if (config.phaseBarrierDir) {
    await waitForRelayLoadPhaseBarrier({
      directory: config.phaseBarrierDir,
      shardCount: config.shardCount,
      shardIndex: config.shardIndex,
      timeoutMs: config.phaseBarrierTimeoutMs
    })
    state.phaseBarrierPassed = true
  }
  state.steadyStarted = true
  state.steadyMinimumActive = state.active.size
  const spliceIndexes = relayLoadSpliceIndexes(config)
  const readerOrigins = spliceIndexes.flatMap((index, spliceIndex) =>
    relayLoadSpliceProfile(config, spliceIndex).readerMode === 'normal'
      ? []
      : [peers.get(index).lastAssignment.cellUrl]
  )
  state.readerEvidence = await createRelayLoadReaderEvidence(readerOrigins, {
    readQueuedBytes: readRuntimeQueuedBytes,
    delay
  })
  if (config.phaseBarrierDir) {
    await waitForRelayLoadPhaseBarrier({
      directory: `${config.phaseBarrierDir}-splices`,
      shardCount: config.shardCount,
      shardIndex: config.shardIndex,
      timeoutMs: config.phaseBarrierTimeoutMs
    })
  }
  const splicePromises = spliceIndexes.map((index, spliceIndex) =>
    delay(relayLoadSpliceStartDelayMs(config, spliceIndex)).then(() =>
      peers.get(index).openSplice({
        payloadBytes: config.splicePayloadBytes,
        ...relayLoadSpliceProfile(config, spliceIndex),
        observeReaderPressure,
        holdMs: config.spliceHoldMs
      })
    )
  )
  await Promise.all([...splicePromises, delay(config.durationMs)])
}, async () => {
  state.stopping = true
  clearInterval(progressTimer)
  for (const timeout of reconnectTimers) clearTimeout(timeout)
  reconnectTimers.clear()
  await Promise.all([...peers.values()].map((peer) => peer.shutdown()))
  eventLoopDelay.disable()
  state.shutdownEvidence = {
    peerShutdowns: state.peerShutdowns,
    activeControls: state.active.size,
    activeSplices: state.activeSplices,
    reconnectTimers: reconnectTimers.size
  }
})
if (config.requestUnitCleanupTimeoutMs > 0) {
  await waitForRelayLoadRequestUnits({
    directorOrigin: config.directorOrigin,
    adminToken,
    cellId: config.capacityCellId,
    capacityRequests: config.requestUnitCapacity,
    expectedRequestUnits: 0,
    expectedActivityLeases: 0,
    timeoutMs: config.requestUnitCleanupTimeoutMs
  })
  state.requestUnitCleanupProved = 1
}
const result = report(state, true)
const minimumPeak = config.allowPartial ? 1 : Math.ceil(config.controls * 0.95)
if (result.peakActive < minimumPeak) {
  throw new Error(`peak active controls ${result.peakActive} below required ${minimumPeak}`)
}
if (result.steadyMinimumActive < minimumPeak) {
  throw new Error(
    `steady minimum active controls ${result.steadyMinimumActive} below required ${minimumPeak}`
  )
}
if (relayLoadRunHasDisallowedFailures(result, config)) {
  throw new Error('relay load run observed connection, protocol, refresh, or socket errors')
}
const readerEvidenceError = relayLoadReaderEvidenceError(result, config)
if (readerEvidenceError) throw new Error(readerEvidenceError)
if (
  result.failedSplices > 0 ||
  result.completedSplices + result.wedgedReaderSplicesClosed !== config.splices ||
  result.shutdownEvidence.peerShutdowns !== config.controls ||
  result.shutdownEvidence.activeControls !== 0 ||
  result.shutdownEvidence.activeSplices !== 0 ||
  result.shutdownEvidence.reconnectTimers !== 0
) {
  throw new Error('relay load run did not complete splices or shut down cleanly')
}
