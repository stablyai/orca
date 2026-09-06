import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isWslUncPath, parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import { WSL_CODEX_RUNTIME_HOME_SEGMENTS } from '../pty/codex-home-wsl-env'
import { getWslHomeAsync, listRunningWslDistrosAsync, listRunningWslHomeDirsAsync } from '../wsl'
import {
  filterPathsToRunningWslDistrosAsync,
  filterPathsToWslDistros
} from '../wsl-running-path-filter'
import { wslGatedAccess } from './wsl-transcript-fs-access'
import { WslTranscriptFsError, wslTranscriptFsRefusal } from './wsl-transcript-fs-gate'

/**
 * True for guest-absolute Linux paths that Win32 cannot open as-is.
 * Drive letters, UNC shares, and relative paths are left alone.
 */
export function isGuestAbsoluteLinuxPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) {
    return false
  }
  // Why: a Windows drive path normalized with forward slashes (`/C:/…`) must not
  // be rewritten as a WSL guest path.
  if (/^\/[A-Za-z]:(\/|$)/.test(path)) {
    return false
  }
  return isAbsolute(path)
}

/** True when this host is Windows and `path` is a WSL guest path it cannot open. */
export function needsWslHostTranslation(
  path: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && isGuestAbsoluteLinuxPath(path.trim())
}

export function needsWslHostResolution(
  path: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return needsWslHostTranslation(path, platform) || (platform === 'win32' && isWslUncPath(path))
}

export type WslTranscriptResolutionSnapshot = {
  runningDistros: string[]
  homeDirs?: string[]
}

/** One running-distro view shared by every WSL lookup in a resolve attempt. */
export async function createWslTranscriptResolutionSnapshot(
  options: {
    includeHomes?: boolean
  } = {}
): Promise<WslTranscriptResolutionSnapshot> {
  const runningDistros = await listRunningWslDistrosAsync()
  if (options.includeHomes === false) {
    return { runningDistros }
  }
  const homes = await Promise.all(runningDistros.map((distro) => getWslHomeAsync(distro)))
  return { runningDistros, homeDirs: homes.filter((home): home is string => home !== null) }
}

async function snapshotHomeDirs(snapshot: WslTranscriptResolutionSnapshot): Promise<string[]> {
  if (snapshot.homeDirs) {
    return snapshot.homeDirs
  }
  const homes = await Promise.all(snapshot.runningDistros.map((distro) => getWslHomeAsync(distro)))
  return homes.filter((home): home is string => home !== null)
}

export type HostReadableTranscriptPathDeps = {
  platform?: NodeJS.Platform
  pathExists?: (path: string) => Promise<boolean>
  signal?: AbortSignal
  /** Each installed WSL distro's `$HOME` as a Windows UNC path. */
  listWslHomeDirs?: () => Promise<string[]>
  wslSnapshot?: WslTranscriptResolutionSnapshot
}

// Why: candidates are `\\wsl.localhost` UNC paths served over 9P. A sync probe
// against a stopped or unreachable distro would stall the Electron main thread
// instead of falling through to the next candidate, so keep this off the loop.
async function pathExistsAsync(path: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  if (!isWslUncPath(path)) {
    return existsSync(path)
  }
  try {
    return await wslGatedAccess(path, 'exact', signal)
  } catch (error) {
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    // A caller abort stays authoritative — it must never read as "missing".
    if (signal?.aborted) {
      throw error
    }
    return false
  }
}

// Test/caller-provided home loaders are cached across resolve ticks. Production
// discovery is revalidated separately so a stale UNC root cannot restart WSL.
const WSL_HOME_DIRS_EMPTY_RETRY_MS = 30_000
// Why: a distro that was booting when we first probed resolves to no $HOME and
// would otherwise be excluded for the whole session. Both branches expire so it
// is retried; getWslHomeAsync caches successes, so a refresh only re-spawns
// wsl.exe for the distros that actually failed.
const WSL_HOME_DIRS_TTL_MS = 5 * 60_000
let cachedWslHomeDirs: string[] | null = null
let cachedWslHomeDirsExpiresAt = 0
let inflightWslHomeDirs: Promise<string[]> | null = null
let getAdditionalCodexHomePaths: (() => readonly string[]) | undefined

export function configureHostReadableTranscriptPathSources(options: {
  getAdditionalCodexHomePaths?: () => readonly string[]
}): void {
  getAdditionalCodexHomePaths = options.getAdditionalCodexHomePaths
}

async function defaultListWslHomeDirs(): Promise<string[]> {
  return listRunningWslHomeDirsAsync()
}

function resolveWslHomeDirs(load?: () => Promise<string[]>): Promise<string[]> {
  return load ? wslHomeDirs(load) : defaultListWslHomeDirs()
}

async function wslHomeDirs(load: () => Promise<string[]>): Promise<string[]> {
  if (cachedWslHomeDirs && Date.now() < cachedWslHomeDirsExpiresAt) {
    return cachedWslHomeDirs
  }
  if (inflightWslHomeDirs) {
    return inflightWslHomeDirs
  }
  inflightWslHomeDirs = load()
    .catch(() => [] as string[])
    .then((dirs) => {
      cachedWslHomeDirs = dirs
      cachedWslHomeDirsExpiresAt =
        Date.now() + (dirs.length > 0 ? WSL_HOME_DIRS_TTL_MS : WSL_HOME_DIRS_EMPTY_RETRY_MS)
      inflightWslHomeDirs = null
      return dirs
    })
  return inflightWslHomeDirs
}

export function resetHostReadableTranscriptPathCacheForTests(): void {
  cachedWslHomeDirs = null
  cachedWslHomeDirsExpiresAt = 0
  inflightWslHomeDirs = null
  getAdditionalCodexHomePaths = undefined
}

/**
 * Map a hook-reported transcript path to a path the local main process can open.
 *
 * WSL Codex hooks report guest Linux paths (`/home/…/rollout-….jsonl`). On
 * Windows the main process must open the equivalent `\\wsl.localhost\…` UNC
 * form; without this, Chat UI never finds the live transcript (#10326).
 *
 * Non-guest paths (macOS/Linux hosts, SSH remote mains, already-UNC or drive
 * paths) are returned unchanged when they exist. When translation is needed,
 * distros whose `$HOME` prefixes the guest path are tried first so multi-distro
 * machines pick the owner.
 */
export async function toHostReadableTranscriptPath(
  transcriptPath: string,
  deps: HostReadableTranscriptPathDeps = {}
): Promise<string | null> {
  const path = transcriptPath.trim()
  if (!path) {
    return null
  }
  deps.signal?.throwIfAborted()
  const pathExists =
    deps.pathExists ?? ((candidate: string) => pathExistsAsync(candidate, deps.signal))
  const platform = deps.platform ?? process.platform
  // Why: classify BEFORE probing — Win32 resolves a bare `/home/…` against the
  // current drive (`C:\home\…`), so a probe first could bind chat to a local
  // look-alike file instead of the real WSL transcript.
  if (!needsWslHostTranslation(path, platform)) {
    if (
      platform === 'win32' &&
      isWslUncPath(path) &&
      (deps.wslSnapshot
        ? filterPathsToWslDistros([path], deps.wslSnapshot.runningDistros)
        : await filterPathsToRunningWslDistrosAsync([path])
      ).length === 0
    ) {
      return null
    }
    return (await pathExists(path)) ? path : null
  }

  const homeDirs = deps.wslSnapshot
    ? await snapshotHomeDirs(deps.wslSnapshot)
    : await resolveWslHomeDirs(deps.listWslHomeDirs)
  // Sequential on purpose: the ranked order picks the owning distro, and probing
  // every distro at once would fan out 9P calls to ones the user left stopped.
  let unavailable: WslTranscriptFsError | undefined
  for (const distro of rankDistrosForGuestPath(homeDirs, path)) {
    const uncPath = toWindowsWslPath(path, distro)
    try {
      if (await pathExists(uncPath)) {
        return uncPath
      }
    } catch (error) {
      // Why: one stalled distro must not hide another distro's hit.
      unavailable = wslTranscriptFsRefusal(error)
    }
  }
  // No hit and at least one distro never probed: "couldn't look", not "absent".
  if (unavailable) {
    throw unavailable
  }
  return null
}

function rankDistrosForGuestPath(wslHomeUncDirs: readonly string[], guestPath: string): string[] {
  const preferred: string[] = []
  const others: string[] = []
  for (const homeUnc of wslHomeUncDirs) {
    const parsed = parseWslUncPath(homeUnc)
    if (!parsed || preferred.includes(parsed.distro) || others.includes(parsed.distro)) {
      continue
    }
    const guestHome = parsed.linuxPath.replace(/\/+$/, '')
    if (guestHome && (guestPath === guestHome || guestPath.startsWith(`${guestHome}/`))) {
      preferred.push(parsed.distro)
    } else {
      others.push(parsed.distro)
    }
  }
  return [...preferred, ...others]
}

/**
 * WSL Codex sessions live under the guest home, not Windows AppData. Mirror AI
 * Vault's dual-root discovery so the id-based resolve still finds them when the
 * hook path is absent.
 */
export async function wslCodexSessionsDirs(
  deps: Pick<HostReadableTranscriptPathDeps, 'platform' | 'listWslHomeDirs' | 'wslSnapshot'> = {}
): Promise<string[]> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    return []
  }
  const additionalHomes = getAdditionalCodexHomePaths?.() ?? []
  const [homeDirs, runningAdditionalHomes] = await Promise.all([
    deps.wslSnapshot
      ? snapshotHomeDirs(deps.wslSnapshot)
      : resolveWslHomeDirs(deps.listWslHomeDirs),
    deps.wslSnapshot
      ? filterPathsToWslDistros(additionalHomes, deps.wslSnapshot.runningDistros)
      : filterPathsToRunningWslDistrosAsync(additionalHomes)
  ])
  const dirs = homeDirs.flatMap((home) => [
    joinUnderWslHome(home, ...WSL_CODEX_RUNTIME_HOME_SEGMENTS, 'sessions'),
    joinUnderWslHome(home, '.codex', 'sessions')
  ])
  for (const home of runningAdditionalHomes) {
    if (parseWslUncPath(home)) {
      dirs.push(joinUnderWslHome(home, 'sessions'))
    }
  }
  return dirs.filter((dir, index) => dirs.indexOf(dir) === index)
}

// Why: node:path.join is posix-flavoured off Windows and would mangle the
// `\\wsl.localhost\` share prefix these roots must keep.
function joinUnderWslHome(home: string, ...segments: string[]): string {
  return `${home.replace(/[\\/]+$/, '')}\\${segments.join('\\')}`
}
