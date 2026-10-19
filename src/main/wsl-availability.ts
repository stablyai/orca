import { runProcess } from '@orca/process-host'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { buildWslExecArgs } from '../shared/wsl-login-shell-command'
import { wslExeProcessSpec } from './wsl-exe-process'

type WslAvailabilityCache =
  | { available: true }
  /** Not Windows — never re-probed. */
  | { available: false; unsupported: true }
  | { available: false; cachedAt: number; retryable: boolean; failures: number }

let wslAvailableCache: WslAvailabilityCache | null = null
let wslAvailabilityProbeInFlight: Promise<boolean> | null = null
let wslAvailabilityCacheGeneration = 0

const WSL_AVAILABILITY_PROBE_TIMEOUT_MS = 5000
// Why: availability is a separate wsl.exe spawn. Deliberately not a multiple of the
// renderer's 30s capability TTL, so repeated refreshes don't land on this boundary and
// re-probe every cycle.
const WSL_AVAILABILITY_NEGATIVE_CACHE_TTL_MS = 45_000
// Why: even a definitive-looking non-zero exit can be transient — wsl.exe reports one
// while the WSL package is servicing or LxssManager is still starting — so nothing
// latches for the whole session; it just waits much longer before paying the probe again.
const WSL_AVAILABILITY_DEFINITIVE_TTL_MS = 10 * 60_000
const WSL_AVAILABILITY_MAX_RETRY_DELAY_MS = 30 * 60_000

function isPermanentWslAvailabilityCache(cache: WslAvailabilityCache): boolean {
  // Why: re-check the platform so a cache seeded off-Windows can't suppress a real probe.
  return cache.available || ('unsupported' in cache && process.platform !== 'win32')
}

// Why: the probe spawns wsl.exe, so a host with a wedged wsl.exe must not pay it every
// window; back off per consecutive failure.
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

/** Why a probe said no; null means WSL answered. */
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

// `wsl --status` exits 0x1bc when the WSL2 kernel package is missing -- a package
// a WSL1 distro never needed. Node keeps the Windows DWORD; the console prints the
// signed form, and either spelling can reach us.
const MISSING_WSL2_KERNEL_EXIT_CODES: ReadonlySet<number | null> = new Set([-444, 4_294_966_852])

// Cheapest proof the default guest runs: no login shell, no output to parse.
function defaultGuestExecutionProbe(): ProcessSpec {
  return {
    ...wslExeProcessSpec(
      buildWslExecArgs(undefined, ['/bin/true']),
      WSL_AVAILABILITY_PROBE_TIMEOUT_MS
    ),
    maxOutputBytes: 4096
  }
}

/**
 * Whether the default guest runs. A guest probe that could not spawn means "could not
 * ask", so the caller keeps the `--status` answer rather than minting a fresh negative
 * (docs/reference/wsl-probe-failure-semantics.md).
 */
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
    // Why ENOENT is definitive: it means wsl.exe is not on PATH. The explicit spawn
    // directory in `wslExeProcessSpec` rules out a deleted inherited cwd (#16463).
    return { retryable: !(error instanceof Error && 'code' in error && error.code === 'ENOENT') }
  }
  if (status.code === 0) {
    return null
  }
  if (MISSING_WSL2_KERNEL_EXIT_CODES.has(status.code) && (await defaultGuestRuns())) {
    return null
  }
  // Why: a non-zero exit (wsl.exe ran and said no) is answer-shaped and earns the long
  // window; a timeout or signal kill (no exit code) only earns the short one.
  return { retryable: status.code === null }
}

/**
 * Check whether wsl.exe is available and functional on this Windows machine.
 * Success caches for the process lifetime; every failure is re-probed eventually, so
 * a slow wsl.exe activation on a just-installed or just-rebooted machine cannot latch
 * WSL off for the whole session.
 *
 * Why async: the renderer's capability read reaches this over IPC, and a sync probe would
 * block the Electron main thread — every PTY message, window IPC and watchdog beat — for up
 * to 5s on a wedged wsl.exe. Concurrent callers share one spawn.
 */
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

// Why: same contract as the distro getter — report the last observed answer. Going
// null on staleness would drop the `wsl-unavailable` repair prompt and let git and
// PTY silently resolve to a WSL that last failed to respond. `isWslAvailableAsync` is what
// clears it, by re-probing once the retry window lapses.
export function getCachedWslAvailability(): boolean | null {
  return wslAvailableCache?.available ?? null
}

// Why: the two caches expire independently, and `getWslRepairReason` checks availability
// first — so a definitive failure held for 10-30min would report `wsl-unavailable` over a
// WSL that just listed a distro for us. A non-empty list proves wsl.exe ran, so drop the
// stale failure and let the next call re-probe. Non-empty lists are cached for the process
// lifetime, so this cannot re-spawn the probe more than once.
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
