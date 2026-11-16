/**
 * A drive letter mapped to a distro share (`net use W: \\wsl.localhost\Ubuntu`) names a WSL path
 * Orca only recognises in its UNC spelling. Windows resolves a mapped drive's root to its share.
 */
import { realpath } from 'node:fs'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'

const RESOLVE_TIMEOUT_MS = 2_000
const CACHE_TTL_MS = 60_000
const DRIVE_PATH = /^([A-Za-z]):(?:[\\/](.*))?$/

export type WslMappedDriveShareDeps = {
  platform: NodeJS.Platform
  /** The drive root's final path; a mapped network drive answers with its UNC share. */
  realpathRoot: (root: string) => Promise<string>
  now: () => number
  timeoutMs: number
}

type CacheEntry = { at: number; share: Promise<string | null> }

const cache = new Map<string, CacheEntry>()

const defaultDeps: WslMappedDriveShareDeps = {
  platform: process.platform,
  // The native call asks Windows for the final path; the JS one keeps the drive letter.
  realpathRoot: (root) =>
    new Promise((resolve, reject) =>
      realpath.native(root, (error, real) => (error ? reject(error) : resolve(real)))
    ),
  now: Date.now,
  timeoutMs: RESOLVE_TIMEOUT_MS
}

/** The UNC share a drive letter maps into a distro, or null for any other drive. */
function resolveDriveShare(letter: string, deps: WslMappedDriveShareDeps): Promise<string | null> {
  const key = letter.toUpperCase()
  const cached = cache.get(key)
  if (cached && deps.now() - cached.at < CACHE_TTL_MS) {
    return cached.share
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const lookup = deps
    .realpathRoot(`${key}:\\`)
    .then((real) => (parseWslUncPath(real) ? real.replace(/[\\/]+$/, '') : null))
    .catch(() => null)
  // A hung share must not hold the add: it reads as unmapped, and the next add asks again.
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      if (cache.get(key) === entry) {
        cache.delete(key)
      }
      resolve(null)
    }, deps.timeoutMs)
  })
  const entry: CacheEntry = {
    at: deps.now(),
    share: Promise.race([lookup, timeout]).finally(() => clearTimeout(timer))
  }
  cache.set(key, entry)
  return entry.share
}

/**
 * The UNC spelling of a path on a drive mapped to a distro share (`W:\home\u` ->
 * `\\wsl.localhost\Ubuntu\home\u`); null for local drives, other shares, and off Windows.
 */
export async function resolveWslMappedDrivePath(
  path: unknown,
  deps: WslMappedDriveShareDeps = defaultDeps
): Promise<string | null> {
  if (deps.platform !== 'win32' || typeof path !== 'string') {
    return null
  }
  const match = DRIVE_PATH.exec(path)
  if (!match) {
    return null
  }
  const share = await resolveDriveShare(match[1], deps)
  if (!share) {
    return null
  }
  const tail = (match[2] ?? '').replace(/\//g, '\\').replace(/\\+$/, '')
  return tail ? `${share}\\${tail}` : share
}

export function clearWslMappedDriveShareCacheForTests(): void {
  cache.clear()
}
