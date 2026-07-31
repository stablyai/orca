import { execFile, execFileSync } from 'node:child_process'
import { parseWslUncPath, toWindowsWslPath } from '../shared/wsl-paths'
import { filterUserWslDistros, parseWslDistros } from './wsl-distro-list-output'
import { wslDistroListRetryDelayMs } from './wsl-distro-retry'

export { toWindowsWslPath } from '../shared/wsl-paths'

export type WslPathInfo = {
  distro: string
  linuxPath: string
}

/**
 * Detect if a Windows path is a WSL UNC path and extract the distro name
 * and equivalent Linux path.
 *
 * Why: Windows exposes WSL filesystems as UNC paths under \\wsl.localhost\<Distro>\...
 * (modern) or \\wsl$\<Distro>\... (legacy). When a repo lives on a WSL filesystem,
 * native Windows git.exe is either absent or painfully slow — all process spawning
 * must be routed through `wsl.exe -d <distro>` with Linux-native paths instead.
 */
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
 * Why: Win32 fs.statSync against the WSL 9P filesystem (\\wsl.localhost\...)
 * is unreliable for repos that live on the WSL side — it can report ENOENT for
 * directories that exist, which made opening a WSL worktree fail with
 * "Working directory ... does not exist". `wsl.exe -d <distro> test -d` asks
 * the distro directly, which is the authoritative answer. Returns null (rather
 * than false) when wsl.exe is unavailable or errors so callers can fall back to
 * the fs check instead of falsely rejecting a valid directory.
 */
export function wslUncDirectoryExists(uncPath: string): boolean | null {
  if (process.platform !== 'win32') {
    return null
  }
  const info = parseWslUncPath(uncPath)
  if (!info) {
    return null
  }
  try {
    execFileSync('wsl.exe', ['-d', info.distro, '--', 'test', '-d', info.linuxPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    })
    return true
  } catch (error) {
    // A non-zero exit (directory missing) surfaces as an error with a numeric
    // `status`; treat that as a definitive "does not exist". Any other failure
    // (wsl.exe missing, distro not running, timeout) is inconclusive -> null.
    if (typeof (error as { status?: unknown })?.status === 'number') {
      return false
    }
    return null
  }
}

/**
 * Convert a Windows path to a Linux path for commands that will execute inside WSL.
 * Returns the path unchanged if it is already POSIX-style.
 *
 * Why: WSL hook/setup environments may need both the worktree UNC path
 * (\\wsl.localhost\...) and regular Windows install paths (C:\Users\...)
 * translated before passing them to bash. Leaving drive paths untouched
 * breaks scripts that read ORCA_ROOT_PATH or similar env vars inside WSL.
 */
export function toLinuxPath(windowsPath: string): string {
  const info = parseWslPath(windowsPath)
  if (info) {
    return info.linuxPath
  }

  const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\](.*)$/)
  if (!driveMatch) {
    return windowsPath
  }

  const driveLetter = driveMatch[1].toLowerCase()
  const rest = driveMatch[2].replace(/\\/g, '/')
  return `/mnt/${driveLetter}/${rest}`
}

// ─── WSL home directory resolution ──────────────────────────────────

const wslHomeCache = new Map<string, string>()
let wslDistroCache: string[] | null = null
// Why: a wsl.exe failure must stay retryable (a transient error would
// otherwise hide every distro until restart), but repeated failures cannot
// re-spawn a blocking wsl.exe on every caller; brief negative caching bounds
// the spawn rate on machines where WSL is absent or persistently broken.
// Empty and failed probes back off from 15 seconds to a five-minute cap.
let wslDistroListRetryAfterMs = 0
let wslDistroListEmptyStreak = 0
let wslDistroProbeSequence = 0
let wslDistroCacheSequence = 0
// Why: availability is a separate, blocking probe. Deliberately not a multiple of the
// renderer's 30s capability TTL, so repeated refreshes don't land on this boundary and
// re-probe every cycle.
const WSL_AVAILABILITY_NEGATIVE_CACHE_TTL_MS = 45_000

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
    const output = execFileSync('wsl.exe', ['--list', '--quiet'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    })
    return cacheWslDistroList(parseWslDistros(output), probeSequence)
  } catch {
    armWslDistroListRetry()
    return wslDistroCache ?? []
  }
}

export async function listWslDistrosAsync(): Promise<string[]> {
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
    const output = await execFileUtf8('wsl.exe', ['--list', '--quiet'])
    return cacheWslDistroList(parseWslDistros(output), probeSequence)
  } catch {
    armWslDistroListRetry()
    return wslDistroCache ?? []
  }
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
  if (wslHomeCache.has(distro)) {
    return wslHomeCache.get(distro)!
  }

  try {
    const home = execFileSync('wsl.exe', ['-d', distro, '--', 'bash', '-c', 'echo $HOME'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    }).trim()

    if (!home || !home.startsWith('/')) {
      return null
    }

    const uncPath = toWindowsWslPath(home, distro)
    wslHomeCache.set(distro, uncPath)
    return uncPath
  } catch {
    return null
  }
}

export async function getWslHomeAsync(distro: string): Promise<string | null> {
  if (wslHomeCache.has(distro)) {
    return wslHomeCache.get(distro)!
  }

  try {
    const home = (
      await execFileUtf8('wsl.exe', ['-d', distro, '--', 'bash', '-c', 'echo $HOME'])
    ).trim()

    if (!home || !home.startsWith('/')) {
      return null
    }

    const uncPath = toWindowsWslPath(home, distro)
    wslHomeCache.set(distro, uncPath)
    return uncPath
  } catch {
    return null
  }
}

type WslAvailabilityCache =
  | { available: true }
  /** Not Windows — never re-probed. */
  | { available: false; unsupported: true }
  | { available: false; cachedAt: number; retryable: boolean; failures: number }

function isPermanentWslAvailabilityCache(cache: WslAvailabilityCache): boolean {
  // Why: re-check the platform so a cache seeded off-Windows can't suppress a real probe.
  return cache.available || ('unsupported' in cache && process.platform !== 'win32')
}

let wslAvailableCache: WslAvailabilityCache | null = null

// Why: even a definitive-looking non-zero exit can be transient — wsl.exe reports one
// while the WSL package is servicing or LxssManager is still starting — so nothing
// latches for the whole session; it just waits much longer before paying the probe again.
const WSL_AVAILABILITY_DEFINITIVE_TTL_MS = 10 * 60_000
const WSL_AVAILABILITY_MAX_RETRY_DELAY_MS = 30 * 60_000

// Why: the probe blocks the main process for up to 5s, so a host with a wedged wsl.exe
// must not pay it every window; back off per consecutive failure.
function wslAvailabilityRetryDelayMs(cache: { retryable: boolean; failures: number }): number {
  const base = cache.retryable
    ? WSL_AVAILABILITY_NEGATIVE_CACHE_TTL_MS
    : WSL_AVAILABILITY_DEFINITIVE_TTL_MS
  return Math.min(base * 2 ** (cache.failures - 1), WSL_AVAILABILITY_MAX_RETRY_DELAY_MS)
}

// Why: a numeric `status` (wsl.exe ran and said no) or ENOENT (not installed) is
// answer-shaped, so it earns a long window rather than the short one a timeout gets.
// Same numeric-status rule as `wslUncDirectoryExists`; neither latches forever.
function isRetryableWslProbeFailure(error: unknown): boolean {
  const failure = error as { status?: unknown; code?: unknown } | null
  if (typeof failure?.status === 'number') {
    return false
  }
  return failure?.code !== 'ENOENT'
}

// Why: the two caches expire independently, and `getWslRepairReason` checks availability
// first — so a definitive failure held for 10-30min would report `wsl-unavailable` over a
// WSL that just listed a distro for us. A non-empty list proves wsl.exe ran, so drop the
// stale failure and let the next call re-probe. Non-empty lists are cached for the process
// lifetime, so this cannot re-spawn the blocking probe more than once.
function dropStaleWslAvailabilityFailure(): void {
  if (wslAvailableCache && !wslAvailableCache.available && !('unsupported' in wslAvailableCache)) {
    wslAvailableCache = null
  }
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

/**
 * Check whether wsl.exe is available and functional on this Windows machine.
 * Success caches for the process lifetime; every failure is re-probed eventually, so
 * a slow wsl.exe activation on a just-installed or just-rebooted machine cannot latch
 * WSL off for the whole session.
 */
export function isWslAvailable(): boolean {
  if (wslAvailableCache && isWslAvailabilityCacheFresh(wslAvailableCache)) {
    return wslAvailableCache.available
  }

  const previousFailures =
    wslAvailableCache && 'failures' in wslAvailableCache ? wslAvailableCache.failures : 0

  if (process.platform !== 'win32') {
    wslAvailableCache = { available: false, unsupported: true }
    return false
  }

  try {
    execFileSync('wsl.exe', ['--status'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    })
    wslAvailableCache = { available: true }
  } catch (error) {
    wslAvailableCache = {
      available: false,
      cachedAt: Date.now(),
      retryable: isRetryableWslProbeFailure(error),
      failures: previousFailures + 1
    }
  }

  return wslAvailableCache.available
}

export function hasCachedWslAvailability(): boolean {
  return wslAvailableCache !== null
}

// Why: same contract as the distro getter — report the last observed answer. Going
// null on staleness would drop the `wsl-unavailable` repair prompt and let git and
// PTY silently resolve to a WSL that last failed to respond. `isWslAvailable` is what
// clears it, by re-probing once the retry window lapses.
export function getCachedWslAvailability(): boolean | null {
  return wslAvailableCache?.available ?? null
}

export function _resetWslCachesForTests(): void {
  wslHomeCache.clear()
  wslDistroCache = null
  wslDistroListRetryAfterMs = 0
  wslDistroListEmptyStreak = 0
  wslDistroProbeSequence = 0
  wslDistroCacheSequence = 0
  wslAvailableCache = null
}

// Why: seeded state expires like real state — an `available: false` seed is re-probed
// once its window lapses, and a `distros` seed is filtered and arms the retry window.
// Tests that advance timers past either window must mock child_process.
export function _setWslCachesForTests(args: {
  available?: boolean | null
  distros?: string[] | null
  availabilityRetryable?: boolean
}): void {
  wslAvailableCache =
    args.available === true
      ? { available: true }
      : args.available === false
        ? {
            available: false,
            cachedAt: Date.now(),
            retryable: args.availabilityRetryable ?? false,
            failures: 1
          }
        : null
  // Why: seed through the real cache path so an empty seed arms the retry window
  // too — otherwise a seeded [] lets the next call spawn a real 5s wsl.exe.
  wslDistroListRetryAfterMs = 0
  wslDistroListEmptyStreak = 0
  wslDistroProbeSequence = 0
  wslDistroCacheSequence = 0
  wslDistroCache = null
  if (args.distros) {
    cacheWslDistroList(args.distros, ++wslDistroProbeSequence)
  }
}

function execFileUtf8(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf-8', timeout: 5000 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}
