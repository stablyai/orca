import { runProcess, runProcessSync } from '@orca/process-host'

const PWSH_SYNC_PROBE_TIMEOUT_MS = 5000
const PWSH_WARMUP_PROBE_TIMEOUT_MS = 30_000
const PWSH_NEGATIVE_CACHE_TTL_MS = 30_000

type PwshAvailabilityCache =
  | { available: true }
  | { available: false; cachedAt: number; retryable: boolean }

let pwshAvailableCache: PwshAvailabilityCache | null = null
let pwshWarmupInFlight: Promise<boolean> | null = null
let pwshProbeInFlight: Promise<boolean> | null = null
let pwshAvailabilityCacheGeneration = 0

function isCacheFresh(cache: PwshAvailabilityCache): boolean {
  return (
    cache.available || !cache.retryable || Date.now() - cache.cachedAt < PWSH_NEGATIVE_CACHE_TTL_MS
  )
}

function writePwshAvailabilityCache(cache: PwshAvailabilityCache | null): void {
  pwshAvailableCache = cache
  pwshAvailabilityCacheGeneration += 1
}

function cachePwshProbeFailure(timedOut: boolean, startedAtGeneration: number): boolean {
  if (startedAtGeneration !== pwshAvailabilityCacheGeneration) {
    return pwshAvailableCache?.available ?? false
  }
  // Slow .NET cold starts must not permanently disable the user’s PowerShell 7 preference.
  if (timedOut) {
    writePwshAvailabilityCache(null)
    return false
  }
  writePwshAvailabilityCache({ available: false, cachedAt: Date.now(), retryable: true })
  return false
}

/** Cache success for the process lifetime; retry transient failures. */
export function isPwshAvailable(): boolean {
  if (pwshAvailableCache && isCacheFresh(pwshAvailableCache)) {
    return pwshAvailableCache.available
  }

  // Optimistic availability avoids duplicate warmup probes; shell spawning still has fallbacks.
  if (pwshProbeInFlight || pwshWarmupInFlight) {
    return pwshAvailableCache?.available ?? true
  }

  if (process.platform !== 'win32') {
    writePwshAvailabilityCache({ available: false, cachedAt: Date.now(), retryable: false })
    return false
  }

  const startedAtGeneration = pwshAvailabilityCacheGeneration
  let probe
  try {
    probe = runProcessSync({
      program: 'pwsh.exe',
      args: ['-Version'],
      timeoutMs: PWSH_SYNC_PROBE_TIMEOUT_MS
    })
  } catch {
    return cachePwshProbeFailure(false, startedAtGeneration)
  }
  if (probe.timedOut || probe.code !== 0) {
    return cachePwshProbeFailure(probe.timedOut, startedAtGeneration)
  }
  writePwshAvailabilityCache({ available: true })

  return pwshAvailableCache?.available ?? false
}

/** Share async probes so renderer capability reads cannot block main during PowerShell cold starts. */
export function isPwshAvailableAsync(): Promise<boolean> {
  if (pwshAvailableCache && isCacheFresh(pwshAvailableCache)) {
    return Promise.resolve(pwshAvailableCache.available)
  }

  if (process.platform !== 'win32') {
    writePwshAvailabilityCache({ available: false, cachedAt: Date.now(), retryable: false })
    return Promise.resolve(false)
  }

  if (pwshProbeInFlight) {
    return pwshProbeInFlight
  }

  const startedAtGeneration = pwshAvailabilityCacheGeneration
  pwshProbeInFlight = runProcess({
    program: 'pwsh.exe',
    args: ['-Version'],
    timeoutMs: PWSH_SYNC_PROBE_TIMEOUT_MS
  })
    .then((probe) => {
      pwshProbeInFlight = null
      if (probe.timedOut || probe.code !== 0) {
        return cachePwshProbeFailure(probe.timedOut, startedAtGeneration)
      }
      writePwshAvailabilityCache({ available: true })
      return true
    })
    .catch(() => {
      pwshProbeInFlight = null
      return cachePwshProbeFailure(false, startedAtGeneration)
    })
  return pwshProbeInFlight
}

export function warmPwshAvailabilityCache(): Promise<boolean> {
  if (pwshAvailableCache?.available) {
    return Promise.resolve(true)
  }
  if (process.platform !== 'win32') {
    writePwshAvailabilityCache({ available: false, cachedAt: Date.now(), retryable: false })
    return Promise.resolve(false)
  }
  if (pwshWarmupInFlight) {
    return pwshWarmupInFlight
  }

  const startedAtGeneration = pwshAvailabilityCacheGeneration
  pwshWarmupInFlight = runProcess({
    program: 'pwsh.exe',
    args: ['-Version'],
    timeoutMs: PWSH_WARMUP_PROBE_TIMEOUT_MS
  })
    .then((probe) => {
      pwshWarmupInFlight = null
      if (probe.timedOut || probe.code !== 0) {
        return cachePwshProbeFailure(probe.timedOut, startedAtGeneration)
      }
      writePwshAvailabilityCache({ available: true })
      return true
    })
    .catch(() => {
      pwshWarmupInFlight = null
      return cachePwshProbeFailure(false, startedAtGeneration)
    })
  return pwshWarmupInFlight
}
