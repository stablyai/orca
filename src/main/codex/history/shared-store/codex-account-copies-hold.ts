import {
  type BigIntStats,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { emptyTally, type CopiesTally } from './codex-account-copies-tally'

/**
 * Where a verified copy waits while the open check runs: nothing opens it by this name, so a
 * process that has it open now is one that already did, which the check sees.
 */
export const HELD_COPIES_DIR = '.orca-copies-deleting'

/** A copy whose bytes its ~/.codex original holds, with both files as they were checked. */
export type VerifiedCopy = { copy: string; original: string; copyKey: string; originalKey: string }
export type HeldCopy = {
  held: string
  copy: string
  original: string
  heldKey: string
  originalKey: string
}

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

// A new name for the inode, then the old name dropped: never replaces a file, never loses one.
function moveWithoutReplacing(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  linkSync(from, to)
  unlinkSync(from)
}

function sameFile(path: string, key: string): boolean {
  const stats = lstatOrNull(path)
  return stats !== null && stats.isFile() && stats.nlink === 1n && fileKey(stats) === key
}

/** Moves each copy still as it was checked into the holding folder; the rest stay as they are. */
export function holdVerifiedCopies(
  accountHome: string,
  copies: VerifiedCopy[]
): { held: HeldCopy[]; tally: CopiesTally } {
  const tally = emptyTally()
  const held: HeldCopy[] = []
  for (const copy of copies) {
    try {
      const original = lstatOrNull(copy.original)
      if (
        !isInsideHome(accountHome, copy.copy) ||
        !sameFile(copy.copy, copy.copyKey) ||
        !original ||
        fileKey(original) !== copy.originalKey
      ) {
        tally.changed += 1
        continue
      }
      const target = join(accountHome, HELD_COPIES_DIR, relative(accountHome, copy.copy))
      moveWithoutReplacing(copy.copy, target)
      const stats = lstatSync(target, { bigint: true })
      held.push({
        held: target,
        copy: copy.copy,
        original: copy.original,
        heldKey: fileKey(stats),
        originalKey: copy.originalKey
      })
    } catch {
      tally.error += 1
    }
  }
  return { held, tally }
}

function release(
  copy: Pick<HeldCopy, 'held' | 'copy'>,
  tally: CopiesTally,
  reason: 'open' | 'changed'
): void {
  try {
    moveWithoutReplacing(copy.held, copy.copy)
    tally[reason] += 1
  } catch {
    // Its name was taken meanwhile: it waits held, and a later launch puts it back.
    tally.error += 1
  }
}

/**
 * Deletes each held copy no process has open, if neither file changed since; puts the rest back.
 * `open` null: the check couldn't tell, so every copy goes back.
 */
export function finishHeldCopies(
  accountHome: string,
  held: HeldCopy[],
  open: Set<string> | null
): CopiesTally {
  const tally = emptyTally()
  for (const copy of held) {
    if (!open || open.has(copy.held)) {
      release(copy, tally, 'open')
      continue
    }
    try {
      const original = lstatOrNull(copy.original)
      if (
        !sameFile(copy.held, copy.heldKey) ||
        !original ||
        fileKey(original) !== copy.originalKey
      ) {
        release(copy, tally, 'changed')
        continue
      }
      const bytes = Number(lstatSync(copy.held, { bigint: true }).size)
      unlinkSync(copy.held)
      tally.deleted += 1
      tally.bytesReclaimed += bytes
    } catch {
      tally.error += 1
    }
  }
  removeEmptyFolders(join(accountHome, HELD_COPIES_DIR))
  return tally
}

/** A run cut short (quit, crash) left copies held: each goes back to its own name. */
export function releaseLeftoverHeldCopies(accountHome: string): void {
  const root = join(accountHome, HELD_COPIES_DIR)
  const stats = lstatOrNull(root)
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    return
  }
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.isFile()) {
        release({ held: path, copy: join(accountHome, relative(root, path)) }, emptyTally(), 'open')
      }
    }
  }
  walk(root)
  removeEmptyFolders(root)
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
