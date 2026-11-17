/**
 * A drive letter mapped to a distro share (`net use W: \\wsl.localhost\Ubuntu`) names a WSL path
 * Orca only recognises in its UNC spelling. Windows resolves a mapped drive's root to its share.
 */
import { realpath } from 'node:fs'
import { win32 } from 'node:path'
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

/** `settledAt` is null while the lookup is in flight; an in-flight lookup never expires. */
type CacheEntry = { settledAt: number | null; lookup: Promise<string | null> }

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
  const entry =
    cached && (cached.settledAt === null || deps.now() - cached.settledAt < CACHE_TTL_MS)
      ? cached
      : startDriveLookup(key, deps)
  let timer: ReturnType<typeof setTimeout> | undefined
  // A slow share (a cold distro boots its VM) answers null now; its late answer serves the next add.
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deps.timeoutMs)
  })
  return Promise.race([entry.lookup, timeout]).finally(() => clearTimeout(timer))
}

/** One lookup per drive: a hung share pins one fs thread, never one per add. */
function startDriveLookup(key: string, deps: WslMappedDriveShareDeps): CacheEntry {
  const entry: CacheEntry = { settledAt: null, lookup: Promise.resolve(null) }
  entry.lookup = deps.realpathRoot(`${key}:\\`).then(
    (real) => {
      entry.settledAt = deps.now()
      return parseWslUncPath(real) ? real.replace(/[\\/]+$/, '') : null
    },
    () => {
      // A failed lookup is asked again by the next add.
      if (cache.get(key) === entry) {
        cache.delete(key)
      }
      return null
    }
  )
  cache.set(key, entry)
  return entry
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
  const tail = win32.normalize(match[2] || '.').replace(/^\\+|\\+$/g, '')
  // `..` past the drive root names no folder of the share.
  if (tail === '..' || tail.startsWith('..\\')) {
    return null
  }
  return tail === '' || tail === '.' ? share : `${share}\\${tail}`
}

export function clearWslMappedDriveShareCacheForTests(): void {
  cache.clear()
}
