import { runProcess, runProcessSync } from '@orca/process-host'
import { buildWslExecArgs } from '../shared/wsl-login-shell-command'
import { parseWslUncPath, toWindowsWslPath } from '../shared/wsl-paths'
import { filterUserWslDistros, parseWslDistros } from './wsl-distro-list-output'
import { wslDistroListRetryDelayMs } from './wsl-distro-retry'
import {
  _resetWslAvailabilityCacheForTests,
  _setWslAvailabilityCacheForTests,
  dropStaleWslAvailabilityFailure
} from './wsl-availability'
import { wslExeProcessSpec, wslExeStdout } from './wsl-exe-process'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from './wsl-running-distro-cache'
import {
  getWslDirectoryProbeArgs,
  parseWslDirectoryProbeOutput
} from './wsl-directory-probe-command'
import { clearWslHomeCache, getCachedWslHome, rememberWslHome } from './wsl-home-cache'
export { hasCachedWslHome } from './wsl-home-cache'
// Why re-exported rather than defined here: the relay bundle needs the path
// conversion without this module's distro-probing subprocess graph.
export { toLinuxPath, toWindowsWslPath } from '../shared/wsl-paths'
export {
  getCachedWslAvailability,
  hasCachedWslAvailability,
  isWslAvailableAsync
} from './wsl-availability'
export type WslPathInfo = {
  distro: string
  linuxPath: string
}

const WSL_PROBE_TIMEOUT_MS = 5000

function wslHomeProbeArgs(distro: string): string[] {
  return buildWslExecArgs(distro, ['bash', '-c', 'echo $HOME'])
}

/** Detect and parse a WSL UNC path on Windows. */
export function parseWslPath(windowsPath: string): WslPathInfo | null {
  if (process.platform !== 'win32') {
    return null
  }

  return parseWslUncPath(windowsPath)
}

export function isWslPath(path: string): boolean {
  return parseWslPath(path) !== null
}

/**
 * Check whether a WSL UNC working directory exists by testing it inside the
 * distro itself, returning null when the answer can't be determined.
 *
 * Why: Win32 fs.stat against the WSL 9P filesystem (\\wsl.localhost\...)
 * is unreliable for repos that live on the WSL side — it can report ENOENT for
 * directories that exist, which made opening a WSL worktree fail with
 * "Working directory ... does not exist". The guest marker probe asks the
 * distro directly, which is the authoritative answer. Returns null (rather
 * than false) when wsl.exe is unavailable or errors so callers can fall back to
 * the fs check instead of falsely rejecting a valid directory.
 */
export function wslUncDirectoryExistsAsync(uncPath: string): Promise<boolean | null> {
  if (process.platform !== 'win32') {
    return Promise.resolve(null)
  }
  const info = parseWslUncPath(uncPath)
  if (!info) {
    return Promise.resolve(null)
  }
  return (
    runProcess(wslExeProcessSpec(getWslDirectoryProbeArgs(info), WSL_PROBE_TIMEOUT_MS))
      // Why: wsl.exe uses numeric exits for both guest results and host failures; only the guest marker is authoritative.
      .then((result) => parseWslDirectoryProbeOutput(result.stdout))
      .catch(() => null)
  )
}

const wslHomeProbeCache = new Map<string, Promise<string | null>>()
let wslDistroCache: string[] | null = null
let wslDistroListInFlight: Promise<string[]> | null = null
// Why: a wsl.exe failure must stay retryable (a transient error would
// otherwise hide every distro until restart), but repeated failures cannot
// re-spawn a blocking wsl.exe on every caller; brief negative caching bounds
// the spawn rate on machines where WSL is absent or persistently broken.
// Empty and failed probes back off from 15 seconds to a five-minute cap.
let wslDistroListRetryAfterMs = 0
let wslDistroListEmptyStreak = 0
let wslDistroProbeSequence = 0
let wslDistroCacheSequence = 0

function armWslDistroListRetry(): void {
  const now = Date.now()
  // Concurrent completions belong to the retry window already armed by the first result.
  if (now < wslDistroListRetryAfterMs) {
    return
  }
  wslDistroListEmptyStreak += 1
  wslDistroListRetryAfterMs = now + wslDistroListRetryDelayMs(wslDistroListEmptyStreak)
}

// Why: `wsl --install` reports zero distros while one is still provisioning, so an
// empty answer is transient and must stay retryable — caching it for the process
// lifetime is what made WSL vanish from the picker after setup. It is still cached
// for reads, so a missing distro stays visible to `isKnownMissingDistro`.
function cacheWslDistroList(rawDistros: string[], probeSequence: number): string[] {
  const userDistros = filterUserWslDistros(rawDistros)
  // An older positive result must not replace the newer lifetime-stable list.
  if (
    probeSequence < wslDistroCacheSequence &&
    (userDistros.length === 0 || (wslDistroCache?.length ?? 0) > 0)
  ) {
    return wslDistroCache ?? []
  }
  // Why: probes overlap and can resolve out of order — a slow pre-registration wsl.exe
  // can land after a fast one that already found the distro. A late empty answer must
  // not erase that list, or provisioning reverts to "no distros" and backs off again.
  if (userDistros.length === 0 && wslDistroCache !== null && wslDistroCache.length > 0) {
    return wslDistroCache
  }
  if (userDistros.length > 0) {
    dropStaleWslAvailabilityFailure()
  }
  wslDistroCacheSequence = probeSequence
  wslDistroCache = userDistros
  if (wslDistroCache.length === 0) {
    armWslDistroListRetry()
  }
  return wslDistroCache
}

/** A non-empty list is stable; an empty one re-probes once the retry window elapses. */
function shouldReuseCachedWslDistros(): boolean {
  return (
    wslDistroCache !== null && (wslDistroCache.length > 0 || Date.now() < wslDistroListRetryAfterMs)
  )
}

export function listWslDistros(): string[] {
  if (shouldReuseCachedWslDistros()) {
    return wslDistroCache ?? []
  }

  if (process.platform !== 'win32') {
    wslDistroCache = []
    return wslDistroCache
  }

  if (Date.now() < wslDistroListRetryAfterMs) {
    return wslDistroCache ?? []
  }

  try {
    const probeSequence = ++wslDistroProbeSequence
    const output = wslExeStdout(
      runProcessSync(wslExeProcessSpec(['--list', '--quiet'], WSL_PROBE_TIMEOUT_MS))
    )
    return cacheWslDistroList(parseWslDistros(output), probeSequence)
  } catch {
    armWslDistroListRetry()
    return wslDistroCache ?? []
  }
}

export async function listWslDistrosAsync(): Promise<string[]> {
  // A non-empty list is lifetime-stable, so never wait on a probe that cannot improve it.
  if (wslDistroCache !== null && wslDistroCache.length > 0) {
    return wslDistroCache
  }
  // Why ahead of the negative cache: a synchronous caller can land an empty result and arm
  // the retry window mid-probe, and handing this caller that [] would strand it even though
  // the pending probe is about to see the distro that just finished provisioning.
  if (wslDistroListInFlight) {
    return wslDistroListInFlight
  }

  if (shouldReuseCachedWslDistros()) {
    return wslDistroCache ?? []
  }

  if (process.platform !== 'win32') {
    wslDistroCache = []
    return wslDistroCache
  }

  if (Date.now() < wslDistroListRetryAfterMs) {
    return wslDistroCache ?? []
  }

  // Capability reads, CLI reconciliation and hook startup all ask before the first result
  // lands; one host-wide answer must cost one wsl.exe spawn. `catch` sits ahead of the
  // stored promise, so joiners get the same fail-safe [] a per-caller catch returned.
  const probeSequence = ++wslDistroProbeSequence
  const probe = runWslExe(['--list', '--quiet'])
    .then((output) => cacheWslDistroList(parseWslDistros(output), probeSequence))
    .catch(() => {
      armWslDistroListRetry()
      return wslDistroCache ?? []
    })
    .finally(() => {
      // Only the probe that owns the slot may clear it; a test reset can install a newer one.
      if (wslDistroListInFlight === probe) {
        wslDistroListInFlight = null
      }
    })
  wslDistroListInFlight = probe
  return probe
}

/** Running user distros only — see `resolveRunningWslDistros` for the fallback/backoff and
 *  single-flight contract shared by every caller. */
export async function listRunningWslDistrosAsync(
  options: { requireConfirmed?: boolean } = {}
): Promise<string[]> {
  if (process.platform !== 'win32') {
    return []
  }
  return resolveRunningWslDistros(
    () =>
      runWslExe(['--list', '--running', '--quiet'], {
        ...process.env,
        WSL_UTF8: '1'
      }).then((output) => filterUserWslDistros(parseWslDistros(output))),
    options
  )
}

export function hasCachedWslDistros(): boolean {
  return wslDistroCache !== null
}

// Why: report the last observed answer even once it is stale. An empty list is a real
// probe result, so it must keep driving the `wsl-distro-missing` repair prompt; going
// null instead fails open and silently spawns `wsl.exe -d <distro>` for a distro Orca
// last saw was absent. Staleness self-corrects — `listWslDistros` re-probes after the
// retry window and a distro installed since clears the prompt on its own.
export function getCachedWslDistros(): string[] | null {
  return wslDistroCache
}

export function getDefaultWslDistro(): string | null {
  return listWslDistros()[0] ?? null
}

/**
 * Get the home directory for a WSL distro, returned as a Windows UNC path.
 * Result is cached per distro for the process lifetime.
 *
 * Why: worktrees for WSL repos are created under ~/orca/workspaces inside
 * the WSL filesystem, mirroring the Windows workspace layout. We need the
 * WSL user's $HOME to compute that path.
 */
export function getWslHome(distro: string): string | null {
  const cachedHome = getCachedWslHome(distro)
  if (cachedHome !== undefined) {
    return cachedHome
  }

  try {
    const home = wslExeStdout(
      runProcessSync(wslExeProcessSpec(wslHomeProbeArgs(distro), WSL_PROBE_TIMEOUT_MS))
    ).trim()

    if (!home || !home.startsWith('/')) {
      return null
    }

    const uncPath = toWindowsWslPath(home, distro)
    return rememberWslHome(distro, uncPath)
  } catch {
    return null
  }
}

/** Pure cache lookup — never probes. */
export async function getWslHomeAsync(distro: string): Promise<string | null> {
  const cachedHome = getCachedWslHome(distro)
  if (cachedHome !== undefined) {
    return cachedHome
  }
  const inflight = wslHomeProbeCache.get(distro)
  if (inflight) {
    return inflight
  }

  const probe = runWslExe(wslHomeProbeArgs(distro))
    .then((output) => {
      const home = output.trim()
      if (!home || !home.startsWith('/')) {
        return null
      }
      const uncPath = toWindowsWslPath(home, distro)
      return rememberWslHome(distro, uncPath)
    })
    .catch(() => null)
    .finally(() => {
      if (wslHomeProbeCache.get(distro) === probe) {
        wslHomeProbeCache.delete(distro)
      }
    })
  wslHomeProbeCache.set(distro, probe)
  return probe
}

/** UNC home roots for distros that are running at discovery time. */
export async function listRunningWslHomeDirsAsync(): Promise<string[]> {
  const homes = await Promise.all(
    (await listRunningWslDistrosAsync()).map((distro) => getWslHomeAsync(distro))
  )
  return homes.filter((home): home is string => Boolean(home))
}

// Both test entry points retire the pending probe with the cache it would write into;
// leaving it armed would let a retired probe answer the next test.
function resetWslDistroListState(): void {
  wslDistroCache = null
  wslDistroListInFlight = null
  wslDistroListRetryAfterMs = 0
  wslDistroListEmptyStreak = 0
  wslDistroProbeSequence = 0
  wslDistroCacheSequence = 0
}

export function _resetWslCachesForTests(): void {
  clearWslHomeCache()
  wslHomeProbeCache.clear()
  resetWslDistroListState()
  _resetRunningWslDistroCacheForTests()
  _resetWslAvailabilityCacheForTests()
}

// Why: seeded state expires like real state — an `available: false` seed is re-probed
// once its window lapses, and a `distros` seed is filtered and arms the retry window.
// Tests that advance timers past either window must mock @orca/process-host.
export function _setWslCachesForTests(args: {
  available?: boolean | null
  distros?: string[] | null
  availabilityRetryable?: boolean
}): void {
  _setWslAvailabilityCacheForTests(args.available, args.availabilityRetryable ?? false)
  // Why: seed through the real cache path so an empty seed arms the retry window
  // too — otherwise a seeded [] lets the next call spawn a real 5s wsl.exe.
  resetWslDistroListState()
  if (args.distros) {
    cacheWslDistroList(args.distros, ++wslDistroProbeSequence)
  }
}

async function runWslExe(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return wslExeStdout(await runProcess(wslExeProcessSpec(args, WSL_PROBE_TIMEOUT_MS, env)))
}
