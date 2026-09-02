/**
 * Pure metrics helpers for the live remote bulk-open freeze harness.
 * Kept separate so unit tests can drive the same code the repro uses.
 */

export const DEFAULT_SOFT_MS = 2000
export const DEFAULT_HARD_MS = 5000

export function readFreezeNumberEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${name}: expected a finite number, got ${JSON.stringify(raw)}`)
  }
  return value
}

export function extractTerminalHandle(result) {
  if (!result || typeof result !== 'object') {
    return null
  }
  const candidates = [
    result.handle,
    result.terminalHandle,
    result.agentTerminalHandle,
    typeof result.terminal === 'string' ? result.terminal : result.terminal?.handle,
    result.startupTerminal?.handle,
    result.tab?.terminal,
    result.tab?.handle
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.startsWith('term_')) {
      return value
    }
  }
  for (const value of Object.values(result)) {
    if (typeof value === 'string' && value.startsWith('term_')) {
      return value
    }
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) {
        if (typeof nested === 'string' && nested.startsWith('term_')) {
          return nested
        }
      }
    }
  }
  return null
}

export function worktreeSelector(wt) {
  if (typeof wt?.id === 'string' && wt.id.length > 0) {
    return `id:${wt.id}`
  }
  if (typeof wt?.path === 'string' && wt.path.length > 0) {
    return `path:${wt.path}`
  }
  return null
}

/**
 * Peak stall across individual switch latency and concurrent batch wall.
 * Hard freeze when peak >= hardMs (default 5000).
 */
export function evaluateFreezeSignals({
  maxSwitchMs = 0,
  maxBatchWallMs = 0,
  statusProbeMs = 0,
  memoryProbeMs = null,
  softMs = DEFAULT_SOFT_MS,
  hardMs = DEFAULT_HARD_MS
}) {
  const peakLatencyMs = Math.max(maxSwitchMs, maxBatchWallMs)
  const softFreeze =
    peakLatencyMs >= softMs ||
    statusProbeMs >= softMs ||
    (memoryProbeMs != null && memoryProbeMs >= softMs)
  const hardFreeze =
    peakLatencyMs >= hardMs ||
    statusProbeMs >= hardMs ||
    (memoryProbeMs != null && memoryProbeMs >= hardMs)
  return { peakLatencyMs, softFreeze, hardFreeze }
}

export function shouldCapSwitchTargets(maxSwitchTargets) {
  return Number.isFinite(maxSwitchTargets) && maxSwitchTargets > 0
}

export function applySwitchTargetCap(targets, maxSwitchTargets) {
  if (!shouldCapSwitchTargets(maxSwitchTargets)) {
    return targets
  }
  return targets.slice(0, maxSwitchTargets)
}

/** Scenarios that model real user recovery, not concurrent CLI pileup. */
export const REALISTIC_SCENARIOS = [
  'idle-backlog-open',
  'idle-backlog-reconnect-open',
  'restart-proxy',
  /** Idle + flood + reconnect storm overlapped with concurrent open fan-out. */
  'lockup-storm'
]

/**
 * Permanent lockup: app/host stops making progress — not a single recovered timeout.
 * Distinct from multi-second hard stall that still recovers (status answers, most opens ok).
 */
export function evaluatePermanentLockup({
  timedOutOps = 0,
  statusHangMs = 0,
  consecutiveSwitchFailures = 0,
  openFailed = 0,
  openTotal = 0,
  permanentTimeoutMs = 60_000,
  /** Fraction of opens that must fail to count as lockup without status hang. */
  failRateThreshold = 0.25,
  minTimedOutOps = 3
}) {
  const failRate = openTotal > 0 ? openFailed / openTotal : 0
  const permanentLockup =
    statusHangMs >= permanentTimeoutMs ||
    timedOutOps >= minTimedOutOps ||
    consecutiveSwitchFailures >= 5 ||
    (openTotal >= 8 && failRate >= failRateThreshold)
  return {
    permanentLockup,
    timedOutOps,
    statusHangMs,
    consecutiveSwitchFailures,
    failRate,
    recoveredHardStallCandidate:
      !permanentLockup && timedOutOps < minTimedOutOps && statusHangMs < permanentTimeoutMs
  }
}

/**
 * Peak across open latencies + optional reconnect-refresh wall + probes.
 * Used by the naturalistic harness (no parallel switch amp).
 */
export function evaluateRealisticFreezeSignals({
  maxOpenMs = 0,
  firstOpenMs = 0,
  reconnectRefreshMs = 0,
  statusProbeMs = 0,
  memoryProbeMs = null,
  softMs = DEFAULT_SOFT_MS,
  hardMs = DEFAULT_HARD_MS
}) {
  const peakLatencyMs = Math.max(maxOpenMs, firstOpenMs, reconnectRefreshMs)
  return evaluateFreezeSignals({
    maxSwitchMs: peakLatencyMs,
    maxBatchWallMs: 0,
    statusProbeMs,
    memoryProbeMs,
    softMs,
    hardMs
  })
}

export function humanPaceDelayMs(baseMs, jitterMs = 0) {
  const base = Math.max(0, baseMs)
  const jitter = Math.max(0, jitterMs)
  if (jitter === 0) {
    return base
  }
  return base + Math.floor(Math.random() * (jitter + 1))
}

/** Full-app forever freeze: host RPC dead for a continuous window, not a recovered stall. */
export const DEFAULT_FOREVER_WINDOW_MS = 30_000
export const DEFAULT_STATUS_SLOW_MS = 15_000

/**
 * Analyze mid-storm status samples for a continuous unhealthy window.
 * Sample: { tMs, ms, ok, hang }
 */
export function evaluateFullAppFreeze({
  statusSamples = [],
  statusSummary = {},
  foreverWindowMs = DEFAULT_FOREVER_WINDOW_MS,
  statusSlowMs = DEFAULT_STATUS_SLOW_MS,
  killOnlyRecovery = false
}) {
  const infrastructureErrors = statusSamples.filter((sample) => sample.infrastructureError)
  const infrastructureErrorCount = Math.max(
    infrastructureErrors.length,
    statusSummary.infrastructureErrorCount ?? 0
  )
  const maxStatusMs = Math.max(
    0,
    ...statusSamples.map((s) => s.ms || 0),
    statusSummary.maxStatusMs ?? 0
  )
  if (killOnlyRecovery) {
    return {
      foreverUiLockupObserved: true,
      longestUnhealthyWindowMs: foreverWindowMs,
      maxStatusMs,
      unhealthySampleCount: statusSummary.sampleCount ?? statusSamples.length,
      infrastructureErrorCount,
      reason: 'kill-only recovery documented'
    }
  }

  const unhealthy = statusSamples.map((s) => {
    const hang = !s.infrastructureError && (Boolean(s.hang) || s.ok === false)
    const slow = !s.infrastructureError && (s.ms || 0) >= statusSlowMs
    return { ...s, unhealthy: hang || slow }
  })

  let longest = statusSummary.longestUnhealthyWindowMs ?? 0
  let runStart = null
  for (const s of unhealthy) {
    if (s.unhealthy) {
      runStart ??= s.tMs ?? 0
      const end = (s.tMs ?? 0) + (s.ms || 0)
      longest = Math.max(longest, end - runStart)
    } else {
      runStart = null
    }
  }

  // If timestamps missing, fall back to consecutive unhealthy count * assumed interval.
  if (longest === 0 && unhealthy.some((s) => s.unhealthy)) {
    let run = 0
    for (const s of unhealthy) {
      if (s.unhealthy) {
        run += 1
        longest = Math.max(longest, run)
      } else {
        run = 0
      }
    }
    // Without wall clock, consecutive count alone is not a ms window.
    longest = 0
  }

  const foreverUiLockupObserved = longest >= foreverWindowMs
  const unhealthySampleCount = Math.max(
    unhealthy.filter((s) => s.unhealthy).length,
    statusSummary.unhealthySampleCount ?? 0
  )

  return {
    foreverUiLockupObserved,
    longestUnhealthyWindowMs: longest,
    maxStatusMs,
    unhealthySampleCount,
    infrastructureErrorCount,
    reason: foreverUiLockupObserved
      ? `status unhealthy ≥${foreverWindowMs}ms continuous`
      : infrastructureErrorCount > 0
        ? `status watchdog infrastructure errors: ${infrastructureErrorCount}`
        : maxStatusMs >= statusSlowMs
          ? `status slow peak ${maxStatusMs}ms but no ≥${foreverWindowMs}ms window`
          : 'status remained healthy through storm'
  }
}
