import { randomBytes } from 'node:crypto'
import { type BigIntStats, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { emptyTally, type CopiesTally } from './codex-account-copies-tally'
import {
  fileKey,
  isThreadBusy,
  lstatOrNull,
  onlyOwnerWrites,
  type VerifiedCopy
} from './codex-account-copy-checks'
import {
  busyOnWindows,
  homePath,
  newListName,
  safeToRemove,
  trashFolder,
  writeList,
  type TrashEntry
} from './codex-account-copies-trash-entries'

// Sync file calls on purpose: this runs on the copies cleanup's own worker thread.

/**
 * Moves each copy the open check just cleared into the home's trash, while Codex's lock
 * coordination is held in `lockFolders` (by the caller), only when no Codex holds the thread and
 * both files are exactly as their comparison saw them. A move loses no bytes, so one that ends
 * after the caller let go of the locks is still safe: the trash is checked again before deleting.
 */
export function moveCheckedCopiesToTrash(
  accountHome: string,
  copies: VerifiedCopy[],
  lockFolders: readonly string[],
  now = Date.now()
): CopiesTally {
  const tally = emptyTally()
  const passing: { copy: VerifiedCopy; stats: BigIntStats }[] = []
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
      // The link checks go last: a folder swapped for a link since would send the move elsewhere.
      if (
        !stats?.isFile() ||
        fileKey(stats) !== copy.copyKey ||
        !original ||
        fileKey(original) !== copy.originalKey ||
        !safeToRemove(accountHome, copy.copy, stats)
      ) {
        tally.changed += 1
        continue
      }
      passing.push({ copy, stats })
    } catch {
      tally.error += 1
    }
  }
  if (passing.length === 0) {
    return tally
  }
  let trash: string | null = null
  try {
    trash = trashFolder(accountHome, true)
  } catch {
    // Kept below.
  }
  // Random too: two launches in the same millisecond must not pick the same names.
  const stamp = `${now.toString(36)}${randomBytes(2).toString('hex')}`
  const moving = passing.map(({ copy, stats }, index) => ({
    copy,
    stats,
    entry: {
      name: `${stamp}-${index}-${basename(copy.copy)}`,
      from: homePath(accountHome, copy.copy),
      original: copy.original,
      copyKey: copy.copyKey,
      originalKey: copy.originalKey,
      movedAt: now
    } satisfies TrashEntry
  }))
  const listName = newListName(now)
  // Listed before any move, so a copy in the trash always has its origin and checks on record.
  if (
    !trash ||
    !writeList(
      trash,
      listName,
      moving.map((m) => m.entry)
    )
  ) {
    tally.error += passing.length
    return tally
  }
  for (const { copy, stats, entry } of moving) {
    try {
      const target = join(trash, entry.name)
      if (lstatOrNull(target)) {
        tally.error += 1
        continue
      }
      renameSync(copy.copy, target)
      tally.trashed += 1
      tally.bytesTrashed += Number(stats.size)
      const moved = lstatOrNull(target)
      if (moved) {
        entry.movedKey = fileKey(moved)
      }
    } catch (error) {
      // Windows: a handle opened without delete sharing, which a writer's could be.
      tally[busyOnWindows(error) ? 'open' : 'error'] += 1
    }
  }
  if (tally.trashed > 0) {
    writeList(
      trash,
      listName,
      moving.map((m) => m.entry)
    )
  }
  return tally
}
