import { existsSync } from 'node:fs'
import { isAbsolute, posix } from 'node:path'
import { isWslUncPath, parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import {
  uniqueDirs,
  wslHomeSessionDirs,
  type SessionHomeAgent
} from '../ai-vault/session-scanner-roots'
import { getWslHomeAsync, listRunningWslHomeDirsAsync, resolveWslGuestRealDirAsync } from '../wsl'
import {
  filterPathsToRunningWslDistrosAsync,
  filterPathsToWslDistros
} from '../wsl-running-path-filter'
import { wslGatedAccess } from './wsl-transcript-fs-access'
import { WslTranscriptFsError, wslTranscriptFsRefusal } from './wsl-transcript-fs-gate'

export function isGuestAbsoluteLinuxPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) {
    return false
  }
  // Forward-slash-normalized Windows drives are not WSL guest paths.
  if (/^\/[A-Za-z]:(\/|$)/.test(path)) {
    return false
  }
  return isAbsolute(path)
}

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
  /** Omit only for discovery without an attested provider distro. */
  wslDistro?: string
  listWslHomeDirs?: () => Promise<string[]>
  wslSnapshot?: WslTranscriptResolutionSnapshot
  resolveGuestRealDir?: (distro: string, guestDir: string) => Promise<string | null>
}

// Probe asynchronously: unreachable WSL 9P shares can stall the main thread.
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
    if (signal?.aborted) {
      throw error
    }
    return false
  }
}

// Cache injected loaders across polls; production revalidates roots to avoid restarting stopped WSL.
const WSL_HOME_DIRS_EMPTY_RETRY_MS = 30_000
// Retry partial/cold-boot discovery; successful homes are already cached.
const WSL_HOME_DIRS_TTL_MS = 5 * 60_000
let cachedWslHomeDirs: string[] | null = null
let cachedWslHomeDirsExpiresAt = 0
let inflightWslHomeDirs: Promise<string[]> | null = null
let getAdditionalCodexHomePaths: (() => readonly string[]) | undefined
// Share in-flight and recent answers so polling a missing transcript does not spawn wsl.exe every tick.
const guestRealDirs = new Map<string, { realDir: Promise<string | null>; expiresAt: number }>()
// Also bounds how long a retargeted symlink keeps resolving to its former directory.
const GUEST_REAL_DIR_TTL_MS = 30_000

export function configureHostReadableTranscriptPathSources(options: {
  getAdditionalCodexHomePaths?: () => readonly string[]
}): void {
  getAdditionalCodexHomePaths = options.getAdditionalCodexHomePaths
}

/** WSL shares use the separate distro tier. */
export function hostAdditionalCodexHomePaths(): string[] {
  return (getAdditionalCodexHomePaths?.() ?? []).filter((home) => !isWslUncPath(home))
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
  guestRealDirs.clear()
}

/** UNC twin of a guest path whose directory is a symlink (e.g. a Claude profile's `projects`). */
async function guestSymlinkTarget(
  guestPath: string,
  distro: string,
  deps: HostReadableTranscriptPathDeps
): Promise<string | null> {
  const dir = posix.dirname(guestPath)
  const key = `${distro}\0${dir}`
  let entry = guestRealDirs.get(key)
  if (!entry || Date.now() >= entry.expiresAt) {
    const resolve = deps.resolveGuestRealDir ?? resolveWslGuestRealDirAsync
    entry = {
      realDir: resolve(distro, dir).catch(() => null),
      expiresAt: Date.now() + GUEST_REAL_DIR_TTL_MS
    }
    guestRealDirs.set(key, entry)
  }
  const realDir = await entry.realDir
  return !realDir || realDir === dir
    ? null
    : toWindowsWslPath(posix.join(realDir, posix.basename(guestPath)), distro)
}

async function probeGuestPath(
  guestPath: string,
  distro: string,
  pathExists: (path: string) => Promise<boolean>,
  deps: HostReadableTranscriptPathDeps
): Promise<string | null> {
  const uncPath = toWindowsWslPath(guestPath, distro)
  if (await pathExists(uncPath)) {
    return uncPath
  }
  const linkedPath = await guestSymlinkTarget(guestPath, distro, deps)
  return linkedPath && (await pathExists(linkedPath)) ? linkedPath : null
}

/** Translate WSL guest paths to host-readable UNC paths, preferring homes matching the guest path. */
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
  const exactWslDistro = deps.wslDistro?.trim()
  if (platform === 'win32' && exactWslDistro) {
    const parsedUnc = parseWslUncPath(path)
    if (parsedUnc && parsedUnc.distro !== exactWslDistro) {
      return null
    }
    const candidate = needsWslHostTranslation(path, platform)
      ? toWindowsWslPath(path, exactWslDistro)
      : path
    // Provider attestation does not prove the distro’s share is still available.
    if (
      isWslUncPath(candidate) &&
      (deps.wslSnapshot
        ? filterPathsToWslDistros([candidate], deps.wslSnapshot.runningDistros)
        : await filterPathsToRunningWslDistrosAsync([candidate])
      ).length === 0
    ) {
      return null
    }
    if (candidate !== path) {
      return probeGuestPath(path, exactWslDistro, pathExists, deps)
    }
    return (await pathExists(candidate)) ? candidate : null
  }
  // Classify before probing: Win32 resolves /home on the current drive and may find a local look-alike.
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
  // Probe ranked distros sequentially to avoid unnecessary 9P calls into stopped distros.
  let unavailable: WslTranscriptFsError | undefined
  for (const distro of rankDistrosForGuestPath(homeDirs, path)) {
    try {
      const hostPath = await probeGuestPath(path, distro, pathExists, deps)
      if (hostPath) {
        return hostPath
      }
    } catch (error) {
      unavailable = wslTranscriptFsRefusal(error)
    }
  }
  // An incomplete probe cannot prove absence.
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

/** Running distro roots live under guest homes; reuse AI Vault roots for lookup without hook paths. */
export async function wslAgentSessionsDirs(
  agent: SessionHomeAgent,
  deps: Pick<HostReadableTranscriptPathDeps, 'platform' | 'listWslHomeDirs' | 'wslSnapshot'> = {}
): Promise<string[]> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    return []
  }
  const additionalHomes = agent === 'codex' ? (getAdditionalCodexHomePaths?.() ?? []) : []
  const [homeDirs, runningAdditionalHomes] = await Promise.all([
    deps.wslSnapshot
      ? snapshotHomeDirs(deps.wslSnapshot)
      : resolveWslHomeDirs(deps.listWslHomeDirs),
    deps.wslSnapshot
      ? filterPathsToWslDistros(additionalHomes, deps.wslSnapshot.runningDistros)
      : filterPathsToRunningWslDistrosAsync(additionalHomes)
  ])
  const dirs = wslHomeSessionDirs(agent, homeDirs, joinUnderWslHome)
  for (const home of runningAdditionalHomes) {
    if (parseWslUncPath(home)) {
      dirs.push(joinUnderWslHome(home, 'sessions'))
    }
  }
  return uniqueDirs(dirs)
}

// Preserve UNC syntax even when node:path uses POSIX semantics on this host.
function joinUnderWslHome(home: string, ...segments: string[]): string {
  return `${home.replace(/[\\/]+$/, '')}\\${segments.join('\\')}`
}
