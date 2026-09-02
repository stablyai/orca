import { runProcess, runProcessSync } from '../shared/child-process/run-process'

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
  // Why: pwsh.exe cold starts can exceed the sync timeout; do not let one slow
  // .NET startup disable the user's PowerShell 7 preference for the daemon.
  if (timedOut) {
    writePwshAvailabilityCache(null)
    return false
  }
  writePwshAvailabilityCache({ available: false, cachedAt: Date.now(), retryable: true })
  return false
}

/**
 * Check whether pwsh.exe is available on this Windows machine.
 * Positive results are cached for the process lifetime; negative results are
 * retried so transient cold-start failures cannot outlive the daemon.
 */
export function isPwshAvailable(): boolean {
  if (pwshAvailableCache && isCacheFresh(pwshAvailableCache)) {
    return pwshAvailableCache.available
  }

  // Why: daemon shell resolution is synchronous but has a spawn fallback chain; an optimistic
  // cold answer avoids launching a duplicate probe while its startup warmup is still running.
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
    // pwsh.exe is not on PATH at all.
    return cachePwshProbeFailure(false, startedAtGeneration)
  }
  if (probe.timedOut || probe.code !== 0) {
    return cachePwshProbeFailure(probe.timedOut, startedAtGeneration)
  }
  writePwshAvailabilityCache({ available: true })

  return pwshAvailableCache?.available ?? false
}

/**
 * Async twin of `isPwshAvailable`, sharing its cache.
 *
 * Why: the renderer's capability read reaches this over IPC, and the sync probe blocks the
 * Electron main thread for up to 5s when pwsh.exe cold-starts. Concurrent callers share one spawn.
 */
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
