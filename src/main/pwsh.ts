import { execFile, execFileSync } from 'node:child_process'

const PWSH_SYNC_PROBE_TIMEOUT_MS = 5000
const PWSH_WARMUP_PROBE_TIMEOUT_MS = 30_000
const PWSH_NEGATIVE_CACHE_TTL_MS = 30_000

type PwshAvailabilityCache =
  | { available: true }
  | { available: false; cachedAt: number; retryable: boolean }

let pwshAvailableCache: PwshAvailabilityCache | null = null
let pwshWarmupInFlight: Promise<boolean> | null = null

function isCacheFresh(cache: PwshAvailabilityCache): boolean {
  return (
    cache.available || !cache.retryable || Date.now() - cache.cachedAt < PWSH_NEGATIVE_CACHE_TTL_MS
  )
}

function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
  )
}

function cachePwshProbeFailure(error: unknown): void {
  // Why: pwsh.exe cold starts can exceed the sync timeout; do not let one slow
  // .NET startup disable the user's PowerShell 7 preference for the daemon.
  if (isTimeoutError(error)) {
    pwshAvailableCache = null
    return
  }
  pwshAvailableCache = { available: false, cachedAt: Date.now(), retryable: true }
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

  if (process.platform !== 'win32') {
    pwshAvailableCache = { available: false, cachedAt: Date.now(), retryable: false }
    return false
  }

  try {
    execFileSync('pwsh.exe', ['-Version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: PWSH_SYNC_PROBE_TIMEOUT_MS
    })
    pwshAvailableCache = { available: true }
  } catch (error) {
    cachePwshProbeFailure(error)
  }

  return pwshAvailableCache?.available ?? false
}

export function warmPwshAvailabilityCache(): Promise<boolean> {
  if (pwshAvailableCache?.available) {
    return Promise.resolve(true)
  }
  if (process.platform !== 'win32') {
    pwshAvailableCache = { available: false, cachedAt: Date.now(), retryable: false }
    return Promise.resolve(false)
  }
  if (pwshWarmupInFlight) {
    return pwshWarmupInFlight
  }

  pwshWarmupInFlight = new Promise((resolve) => {
    execFile('pwsh.exe', ['-Version'], { timeout: PWSH_WARMUP_PROBE_TIMEOUT_MS }, (error) => {
      pwshWarmupInFlight = null
      if (!error) {
        pwshAvailableCache = { available: true }
        resolve(true)
        return
      }
      cachePwshProbeFailure(error)
      resolve(false)
    })
  })
  return pwshWarmupInFlight
}
