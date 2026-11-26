import {
  type BigIntStats,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
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

/** Whether `path`'s folder is where it says inside the home: no link anywhere above it. */
export function isInsideHome(accountHome: string, path: string): boolean {
  try {
    const folder = dirname(path)
    return realpathSync(folder) === join(realpathSync(accountHome), relative(accountHome, folder))
  } catch {
    return false
  }
}

/**
 * Deletes each copy the open check just cleared, only while both files are exactly as their
 * comparison saw them; anything else stays for a later launch.
 */
export function deleteCheckedCopies(accountHome: string, copies: VerifiedCopy[]): CopiesTally {
  const tally = emptyTally()
  for (const copy of copies) {
    try {
      const stats = lstatOrNull(copy.copy)
      const original = lstatOrNull(copy.original)
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
