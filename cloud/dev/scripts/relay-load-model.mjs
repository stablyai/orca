const HEARTBEAT_INTERVAL_MS = 15_000
const REFRESH_MIN_MS = 180_000
const REFRESH_MAX_MS = 240_000

function mix32(value) {
  let mixed = value >>> 0
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad)
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97)
  return (mixed ^ (mixed >>> 15)) >>> 0
}

function fraction(seed, index, stream) {
  return mix32(seed ^ Math.imul(index + 1, 0x9e3779b1) ^ stream) / 0x1_0000_0000
}

export function controlPhase(controlIndex, seed = 0x4f524341) {
  const refreshIntervalMs = Math.round(
    REFRESH_MIN_MS + fraction(seed, controlIndex, 2) * (REFRESH_MAX_MS - REFRESH_MIN_MS)
  )
  return {
    heartbeatOffsetMs: Math.floor(fraction(seed, controlIndex, 1) * HEARTBEAT_INTERVAL_MS),
    refreshIntervalMs,
    refreshOffsetMs: Math.floor(fraction(seed, controlIndex, 3) * refreshIntervalMs),
    reconnectJitterMs: Math.floor(fraction(seed, controlIndex, 4) * 30_000)
  }
}

export function modeledRelayLoad(controlCount, durationMs = 15 * 60_000, seed) {
  if (!Number.isInteger(controlCount) || controlCount < 1) throw new Error('controlCount must be positive')
  const bins = Array.from({ length: Math.ceil(durationMs / 1000) }, () => ({ pings: 0, refreshes: 0 }))
  for (let controlIndex = 0; controlIndex < controlCount; controlIndex++) {
    const phase = controlPhase(controlIndex, seed)
    for (let at = phase.heartbeatOffsetMs; at < durationMs; at += HEARTBEAT_INTERVAL_MS) {
      bins[Math.floor(at / 1000)].pings++
    }
    for (let at = phase.refreshOffsetMs; at < durationMs; at += phase.refreshIntervalMs) {
      bins[Math.floor(at / 1000)].refreshes++
    }
  }
  const totals = bins.reduce(
    (result, bin) => ({
      pings: result.pings + bin.pings,
      refreshes: result.refreshes + bin.refreshes
    }),
    { pings: 0, refreshes: 0 }
  )
  const durationSeconds = durationMs / 1000
  return {
    controlCount,
    durationMs,
    expectedPingRate: controlCount / (HEARTBEAT_INTERVAL_MS / 1000),
    expectedRefreshRate: controlCount / ((REFRESH_MIN_MS + REFRESH_MAX_MS) / 2 / 1000),
    observedPingRate: totals.pings / durationSeconds,
    observedRefreshRate: totals.refreshes / durationSeconds,
    maxPingBurst: Math.max(...bins.map(({ pings }) => pings)),
    maxRefreshBurst: Math.max(...bins.map(({ refreshes }) => refreshes))
  }
}

export function assertSpreadModel(model) {
  const pingTolerance = model.expectedPingRate * 0.03 + 1
  const refreshTolerance = model.expectedRefreshRate * 0.08 + 1
  if (Math.abs(model.observedPingRate - model.expectedPingRate) > pingTolerance) {
    throw new Error('modeled heartbeat rate diverged from the 15-second contract')
  }
  if (Math.abs(model.observedRefreshRate - model.expectedRefreshRate) > refreshTolerance) {
    throw new Error('modeled token refresh rate diverged from the 180-240 second contract')
  }
  if (model.maxPingBurst > model.expectedPingRate * 1.3 + 5) {
    throw new Error('heartbeat phase spreading produced a reconnect cliff')
  }
  // One-second bins have Poisson-sized tails even with uniform phase spreading.
  if (model.maxRefreshBurst > model.expectedRefreshRate * 1.75 + 5) {
    throw new Error('refresh phase spreading produced an auth herd')
  }
}
