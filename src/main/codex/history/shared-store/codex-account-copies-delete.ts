import {
  type BigIntStats,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync
} from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { emptyTally, type CopiesTally } from './codex-account-copies-tally'

/** A copy whose bytes its ~/.codex original holds, with both files as they were checked. */
export type VerifiedCopy = { copy: string; original: string; copyKey: string; originalKey: string }

// Inode, size, mtime and ctime: any write, replace or compression since the check changes one.
export function fileKey(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
}

export function lstatOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

/** No folder between the home and `path`, nor `path` itself, is a link (or a Windows junction). */
export function hasNoLinkBelowHome(accountHome: string, path: string): boolean {
  const parts = relative(accountHome, path).split(/[\\/]/)
  if (parts.length === 0 || parts[0] === '..' || parts[0] === '') {
    return false
  }
  let current = accountHome
  for (const part of parts) {
    current = join(current, part)
    const stats = lstatOrNull(current)
    if (!stats || stats.isSymbolicLink()) {
      return false
    }
  }
  return true
}

/** Whether `path`'s folder is where it says inside the home: no link anywhere above it. */
export function isInsideHome(accountHome: string, path: string): boolean {
  try {
    const folder = dirname(path)
    return realpathSync(folder) === join(realpathSync(accountHome), relative(accountHome, folder))
  } catch {
    return false
  }
}

const THREAD_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/**
 * With Codex's lock coordination held in `lockFolders`, a thread lock file still there is held by
 * a live Codex (any user): that thread, the copy's or the original's, may be written. A name with
 * no thread id, or a lock folder that can't be read, proves nothing.
 */
function isThreadBusy(copy: string, lockFolders: readonly string[]): boolean {
  const ids = basename(copy).toLowerCase().match(THREAD_ID) ?? []
  if (ids.length === 0) {
    return true
  }
  try {
    return lockFolders.some((folder) => ids.some((id) => lstatOrNull(join(folder, `${id}.lock`))))
  } catch {
    return true
  }
}

/**
 * Whether only this user could write the copy: owned by them, with no group or other write bit.
 * Unprivileged `lsof` can't see other users' processes; these can't open the copy to append.
 */
export function onlyOwnerWrites(stats: BigIntStats): boolean {
  if (process.platform === 'win32') {
    return true
  }
  return stats.uid === BigInt(process.getuid?.() ?? -1) && (stats.mode & 0o022n) === 0n
}

/**
 * Deletes each copy the open check just cleared, while Codex's lock coordination is held in
 * `lockFolders` (by the caller), only when no Codex holds the thread and both files are exactly as
 * their comparison saw them; anything else stays for a later launch.
 */
export function deleteCheckedCopies(
  accountHome: string,
  copies: VerifiedCopy[],
  lockFolders: readonly string[]
): CopiesTally {
  const tally = emptyTally()
  for (const copy of copies) {
    try {
      if (lockFolders.length === 0 || isThreadBusy(copy.copy, lockFolders)) {
        tally.busy += 1
        continue
      }
      const stats = lstatOrNull(copy.copy)
      const original = lstatOrNull(copy.original)
      if (stats?.isFile() && !onlyOwnerWrites(stats)) {
        tally.open += 1
        continue
      }
      if (
        !isInsideHome(accountHome, copy.copy) ||
        !stats?.isFile() ||
        stats.nlink !== 1n ||
        fileKey(stats) !== copy.copyKey ||
        !original ||
        fileKey(original) !== copy.originalKey
      ) {
        tally.changed += 1
        continue
      }
      // Checked last: a folder swapped for a link since would send the unlink elsewhere.
      if (!hasNoLinkBelowHome(accountHome, copy.copy)) {
        tally.changed += 1
        continue
      }
      unlinkSync(copy.copy)
      tally.deleted += 1
      tally.bytesReclaimed += Number(stats.size)
    } catch {
      tally.error += 1
    }
  }
  return tally
}

export function removeEmptyFolders(folder: string): void {
  let entries
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      removeEmptyFolders(join(folder, entry.name))
    }
  }
  try {
    rmdirSync(folder)
  } catch {
    // Not empty, or held: it stays.
  }
}
