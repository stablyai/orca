import { runProcess } from '@orca/process-host'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { buildWslExecArgs } from '../shared/wsl-login-shell-command'
import { wslExeProcessSpec } from './wsl-exe-process'

type WslAvailabilityCache =
  | { available: true }
  | { available: false; unsupported: true }
  | { available: false; cachedAt: number; retryable: boolean; failures: number }

let wslAvailableCache: WslAvailabilityCache | null = null
let wslAvailabilityProbeInFlight: Promise<boolean> | null = null
let wslAvailabilityCacheGeneration = 0

const WSL_AVAILABILITY_PROBE_TIMEOUT_MS = 5000
// Avoid aligning expiry with every renderer capability refresh (30s).
const WSL_AVAILABILITY_NEGATIVE_CACHE_TTL_MS = 45_000
// Nonzero exits can be transient during WSL servicing or LxssManager startup; retry after a longer backoff.
const WSL_AVAILABILITY_DEFINITIVE_TTL_MS = 10 * 60_000
const WSL_AVAILABILITY_MAX_RETRY_DELAY_MS = 30 * 60_000

function isPermanentWslAvailabilityCache(cache: WslAvailabilityCache): boolean {
  // An off-Windows test seed must not suppress a Windows probe.
  return cache.available || ('unsupported' in cache && process.platform !== 'win32')
}

function wslAvailabilityRetryDelayMs(cache: { retryable: boolean; failures: number }): number {
  const base = cache.retryable
    ? WSL_AVAILABILITY_NEGATIVE_CACHE_TTL_MS
    : WSL_AVAILABILITY_DEFINITIVE_TTL_MS
  return Math.min(base * 2 ** (cache.failures - 1), WSL_AVAILABILITY_MAX_RETRY_DELAY_MS)
}

function isWslAvailabilityCacheFresh(cache: WslAvailabilityCache): boolean {
  if (isPermanentWslAvailabilityCache(cache)) {
    return true
  }
  if (!('cachedAt' in cache)) {
    return false
  }
  return Date.now() - cache.cachedAt < wslAvailabilityRetryDelayMs(cache)
}

function reusableWslAvailability(): boolean | null {
  return wslAvailableCache && isWslAvailabilityCacheFresh(wslAvailableCache)
    ? wslAvailableCache.available
    : null
}

function previousWslAvailabilityFailures(): number {
  return wslAvailableCache && 'failures' in wslAvailableCache ? wslAvailableCache.failures : 0
}

function writeWslAvailabilityCache(cache: WslAvailabilityCache | null): void {
  wslAvailableCache = cache
  wslAvailabilityCacheGeneration += 1
}

type WslProbeFailure = { retryable: boolean }

function cacheWslAvailabilityProbeResult(
  failure: WslProbeFailure | null,
  startedAtGeneration: number
): boolean {
  if (failure && startedAtGeneration !== wslAvailabilityCacheGeneration) {
    return wslAvailableCache?.available ?? false
  }
  writeWslAvailabilityCache(
    failure
      ? {
          available: false,
          cachedAt: Date.now(),
          retryable: failure.retryable,
          failures: previousWslAvailabilityFailures() + 1
        }
      : { available: true }
  )
  return !failure
}

// Missing WSL2 kernel can leave WSL1 usable; Windows exposes this status in signed or DWORD form.
const MISSING_WSL2_KERNEL_EXIT_CODES: ReadonlySet<number | null> = new Set([-444, 4_294_966_852])

function defaultGuestExecutionProbe(): ProcessSpec {
  return {
    ...wslExeProcessSpec(
      buildWslExecArgs(undefined, ['/bin/true']),
      WSL_AVAILABILITY_PROBE_TIMEOUT_MS
    ),
    maxOutputBytes: 4096
  }
}

async function defaultGuestRuns(): Promise<boolean> {
  try {
    return (await runProcess(defaultGuestExecutionProbe())).code === 0
  } catch {
    return false
  }
}

async function probeWslAvailability(): Promise<WslProbeFailure | null> {
  let status: ProcessResult
  try {
    status = await runProcess(wslExeProcessSpec(['--status'], WSL_AVAILABILITY_PROBE_TIMEOUT_MS))
  } catch (error) {
    // Explicit cwd rules out a deleted inherited directory, so ENOENT means wsl.exe could not be found.
    return { retryable: !(error instanceof Error && 'code' in error && error.code === 'ENOENT') }
  }
  if (status.code === 0) {
    return null
  }
  // Known E9 exception: this `--exec` can start a stopped default distro, but only on a missing kernel.
  if (MISSING_WSL2_KERNEL_EXIT_CODES.has(status.code) && (await defaultGuestRuns())) {
    return null
  }
  // Completed failures get a longer retry delay than timeouts or signal kills without an exit code.
  return { retryable: status.code === null }
}

/** Share asynchronous probes; cache success for the process lifetime and retry failures with backoff. */
export function isWslAvailableAsync(): Promise<boolean> {
  const cached = reusableWslAvailability()
  if (cached !== null) {
    return Promise.resolve(cached)
  }

  if (process.platform !== 'win32') {
    writeWslAvailabilityCache({ available: false, unsupported: true })
    return Promise.resolve(false)
  }

  if (wslAvailabilityProbeInFlight) {
    return wslAvailabilityProbeInFlight
  }

  const startedAtGeneration = wslAvailabilityCacheGeneration
  wslAvailabilityProbeInFlight = probeWslAvailability()
    .then((failure) => cacheWslAvailabilityProbeResult(failure, startedAtGeneration))
    .finally(() => {
      wslAvailabilityProbeInFlight = null
    })
  return wslAvailabilityProbeInFlight
}

export function hasCachedWslAvailability(): boolean {
  return wslAvailableCache !== null
}

// Keep stale failures visible to repair prompts until a retry succeeds.
export function getCachedWslAvailability(): boolean | null {
  return wslAvailableCache?.available ?? null
}

// A discovered distro supersedes a stale availability failure; independent cache TTLs must not hide recovery.
export function dropStaleWslAvailabilityFailure(): void {
  wslAvailabilityCacheGeneration += 1
  if (wslAvailableCache && !wslAvailableCache.available && !('unsupported' in wslAvailableCache)) {
    wslAvailableCache = null
  }
}

export function _resetWslAvailabilityCacheForTests(): void {
  wslAvailableCache = null
  wslAvailabilityProbeInFlight = null
  wslAvailabilityCacheGeneration = 0
}

export function _setWslAvailabilityCacheForTests(
  available: boolean | null | undefined,
  retryable: boolean
): void {
  writeWslAvailabilityCache(
    available === true
      ? { available: true }
      : available === false
        ? { available: false, cachedAt: Date.now(), retryable, failures: 1 }
        : null
  )
}
