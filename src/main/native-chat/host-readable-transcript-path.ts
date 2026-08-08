import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import { WSL_CODEX_RUNTIME_HOME_SEGMENTS } from '../pty/codex-home-wsl-env'
import { getWslHomeAsync, listWslDistrosAsync } from '../wsl'

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

export type HostReadableTranscriptPathDeps = {
  platform?: NodeJS.Platform
  pathExists?: (path: string) => boolean
  /** Each installed WSL distro's `$HOME` as a Windows UNC path. */
  listWslHomeDirs?: () => Promise<string[]>
}

// Why: resolveSessionFilePath runs on a 500ms–5s poll loop. listWslDistrosAsync
// caches, but getWslHomeAsync does NOT cache failures, so a cold/stopped distro
// would re-spawn wsl.exe on every tick. Cache the composed answer here instead.
const WSL_HOME_DIRS_EMPTY_RETRY_MS = 30_000
// Why: a distro that was booting when we first probed resolves to no $HOME and
// would otherwise be excluded for the whole session. Both branches expire so it
// is retried; getWslHomeAsync caches successes, so a refresh only re-spawns
// wsl.exe for the distros that actually failed.
const WSL_HOME_DIRS_TTL_MS = 5 * 60_000
let cachedWslHomeDirs: string[] | null = null
let cachedWslHomeDirsExpiresAt = 0
let inflightWslHomeDirs: Promise<string[]> | null = null

async function defaultListWslHomeDirs(): Promise<string[]> {
  const homes = await Promise.all(
    (await listWslDistrosAsync()).map((distro) => getWslHomeAsync(distro))
  )
  return homes.filter((home): home is string => Boolean(home))
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
  const pathExists = deps.pathExists ?? existsSync
  const platform = deps.platform ?? process.platform
  // Why: classify BEFORE probing — Win32 resolves a bare `/home/…` against the
  // current drive (`C:\home\…`), so a probe first could bind chat to a local
  // look-alike file instead of the real WSL transcript.
  if (!needsWslHostTranslation(path, platform)) {
    return pathExists(path) ? path : null
  }

  const homeDirs = await wslHomeDirs(deps.listWslHomeDirs ?? defaultListWslHomeDirs)
  for (const distro of rankDistrosForGuestPath(homeDirs, path)) {
    const uncPath = toWindowsWslPath(path, distro)
    if (pathExists(uncPath)) {
      return uncPath
    }
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
  deps: Pick<HostReadableTranscriptPathDeps, 'platform' | 'listWslHomeDirs'> = {}
): Promise<string[]> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    return []
  }
  const homeDirs = await wslHomeDirs(deps.listWslHomeDirs ?? defaultListWslHomeDirs)
  return homeDirs.flatMap((home) => [
    joinUnderWslHome(home, ...WSL_CODEX_RUNTIME_HOME_SEGMENTS, 'sessions'),
    joinUnderWslHome(home, '.codex', 'sessions')
  ])
}

// Why: node:path.join is posix-flavoured off Windows and would mangle the
// `\\wsl.localhost\` share prefix these roots must keep.
function joinUnderWslHome(home: string, ...segments: string[]): string {
  return `${home.replace(/[\\/]+$/, '')}\\${segments.join('\\')}`
}
