import { execFile, execFileSync } from 'node:child_process'
import {
  cacheWindowsPwshSupport,
  resolveWindowsPwshExecutablePaths
} from './providers/windows-powershell-executable'

const PWSH_SYNC_PROBE_TIMEOUT_MS = 5000
const PWSH_WARMUP_PROBE_TIMEOUT_MS = 30_000
const PWSH_NEGATIVE_CACHE_TTL_MS = 30_000

type PwshAvailabilityCache =
  | { available: true; executablePath: string }
  | { available: false; cachedAt: number; retryable: boolean }

let pwshAvailableCache: PwshAvailabilityCache | null = null
let pwshWarmupInFlight: Promise<boolean> | null = null

function isPwsh7OrNewer(versionOutput: string | Buffer): boolean {
  const major = /PowerShell\s+(\d+)/i.exec(versionOutput.toString())?.[1]
  return major !== undefined && Number.parseInt(major, 10) >= 7
}

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

function cacheSupportedPath(executablePath: string): void {
  cacheWindowsPwshSupport(executablePath, 'supported')
  pwshAvailableCache = { available: true, executablePath }
}

function cacheUnsupportedPath(executablePath: string): void {
  cacheWindowsPwshSupport(executablePath, 'unsupported')
}

/**
 * Check whether pwsh.exe is available on this Windows machine.
 * Positive results are cached for the process lifetime; negative results are
 * retried so transient cold-start failures cannot outlive the daemon.
 */
export function isPwshAvailable(): boolean {
  return resolveAvailablePwshPath() !== null
}

export function resolveAvailablePwshPath(): string | null {
  if (pwshAvailableCache && isCacheFresh(pwshAvailableCache)) {
    return pwshAvailableCache.available ? pwshAvailableCache.executablePath : null
  }

  if (process.platform !== 'win32') {
    pwshAvailableCache = { available: false, cachedAt: Date.now(), retryable: false }
    return null
  }

  const executablePaths = resolveWindowsPwshExecutablePaths()
  if (executablePaths.length === 0) {
    pwshAvailableCache = { available: false, cachedAt: Date.now(), retryable: true }
    return null
  }

  let retryableError: unknown = null
  for (const executablePath of executablePaths) {
    try {
      const versionOutput = execFileSync(executablePath, ['-Version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: PWSH_SYNC_PROBE_TIMEOUT_MS
      })
      if (isPwsh7OrNewer(versionOutput)) {
        cacheSupportedPath(executablePath)
        return executablePath
      }
      cacheUnsupportedPath(executablePath)
    } catch (error) {
      retryableError = error
    }
  }

  cachePwshProbeFailure(retryableError)
  return null
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

  const executablePaths = resolveWindowsPwshExecutablePaths()
  if (executablePaths.length === 0) {
    pwshAvailableCache = { available: false, cachedAt: Date.now(), retryable: true }
    return Promise.resolve(false)
  }

  pwshWarmupInFlight = new Promise((resolve) => {
    let candidateIndex = 0
    let retryableError: unknown = null
    const probeNext = (): void => {
      const executablePath = executablePaths[candidateIndex]
      candidateIndex += 1
      execFile(
        executablePath,
        ['-Version'],
        { timeout: PWSH_WARMUP_PROBE_TIMEOUT_MS },
        (error, stdout) => {
          if (!error && isPwsh7OrNewer(stdout)) {
            cacheSupportedPath(executablePath)
            pwshWarmupInFlight = null
            resolve(true)
            return
          }
          if (!error) {
            cacheUnsupportedPath(executablePath)
          } else {
            retryableError = error
          }
          if (candidateIndex < executablePaths.length) {
            probeNext()
            return
          }
          cachePwshProbeFailure(retryableError)
          pwshWarmupInFlight = null
          resolve(false)
        }
      )
    }
    probeNext()
  })
  return pwshWarmupInFlight
}
