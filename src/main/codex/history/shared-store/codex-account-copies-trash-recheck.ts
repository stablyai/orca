import {
  type BigIntStats,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { rolloutTwinPath } from '../rollouts/codex-rollout-compressed-twin'
import { originalHoldsCopy } from './codex-account-copy-content'
import { emptyTally, type CopiesTally } from './codex-account-copies-tally'
import {
  fileKey,
  hasNoLinkBelowHome,
  isInsideHome,
  lstatOrNull,
  onlyOwnerWrites,
  trashKey,
  type VerifiedCopy
} from './codex-account-copy-checks'
import {
  busyOnWindows,
  ENTRIES_FILE,
  readEntries,
  RESTORE_ROOT,
  safeToRemove,
  trashFolder,
  TRASH_GRACE_MS,
  writeEntries,
  type TrashEntry
} from './codex-account-copies-trash-entries'

// Sync file calls on purpose: this runs on the copies cleanup's own worker thread.

/** Puts a copy back where it was; false when that place is taken or isn't safely inside the home. */
function restore(accountHome: string, path: string, entry: TrashEntry): boolean {
  const parts = entry.from.split('/')
  if (!RESTORE_ROOT.test(parts[0]) || parts.some((part) => part === '' || part === '..')) {
    return false
  }
  const target = join(accountHome, ...parts)
  if (lstatOrNull(target)) {
    return false
  }
  mkdirSync(dirname(target), { recursive: true })
  if (!hasNoLinkBelowHome(accountHome, dirname(target)) || !isInsideHome(accountHome, target)) {
    return false
  }
  renameSync(path, target)
  return true
}

type DueEntry = { entry: TrashEntry; path: string; stats: BigIntStats }

/**
 * Rechecks, with no lock held, each copy that has waited out its grace period: one whose
 * ~/.codex original still holds every byte, both files unchanged, is returned for the caller's
 * open check and `deleteTrashedCopies`; one that no longer qualifies goes back where it was.
 */
export function recheckTrashedCopies(args: {
  accountHome: string
  maxBytes: number
  deadline: number
  now?: number
}): { ready: VerifiedCopy[]; tally: CopiesTally; bytesRead: number } {
  const tally = emptyTally()
  const ready: VerifiedCopy[] = []
  const trash = trashFolder(args.accountHome, false)
  const entries = trash ? readEntries(trash) : []
  if (!trash || !entries) {
    tally.error += trash ? 1 : 0
    return { ready, tally, bytesRead: 0 }
  }
  const now = args.now ?? Date.now()
  const next: TrashEntry[] = []
  const due: DueEntry[] = []
  for (const entry of entries) {
    const path = join(trash, basename(entry.name))
    const stats = lstatOrNull(path)
    if (!stats) {
      // Listed, but its move never happened; dropped once no late move could still land.
      if (now - entry.movedAt < TRASH_GRACE_MS) {
        next.push(entry)
      }
      continue
    }
    if (now - entry.movedAt < TRASH_GRACE_MS) {
      next.push(entry)
    } else {
      due.push({ entry, path, stats })
    }
  }
  // Smallest first: one huge copy can't hold back the rest, and it resumes where it stopped.
  due.sort((a, b) => Number(a.stats.size - b.stats.size))
  let bytesRead = 0
  for (const { entry, path, stats } of due) {
    let reason: keyof CopiesTally | null = null
    try {
      reason = recheckOne(
        args,
        entry,
        path,
        stats,
        ready,
        () => args.maxBytes - bytesRead,
        (n) => {
          bytesRead += n
        }
      )
    } catch {
      reason = 'error'
    }
    if (reason === null) {
      // Listed until its delete.
      next.push(entry)
      continue
    }
    if (reason === 'deferred' || reason === 'error') {
      tally[reason] += 1
      next.push(entry)
      continue
    }
    try {
      if (restore(args.accountHome, path, entry)) {
        tally.restored += 1
        tally[reason] += 1
        continue
      }
      tally.error += 1
    } catch (error) {
      tally[busyOnWindows(error) ? 'open' : 'error'] += 1
    }
    next.push(entry)
  }
  writeEntries(trash, next)
  return { ready, tally, bytesRead }
}

/**
 * Null: ready, or still due a look (time or bytes ran out); a kept reason: the copy goes back.
 * 'error' and 'deferred' keep it in the trash.
 */
function recheckOne(
  args: { accountHome: string; deadline: number },
  entry: TrashEntry,
  path: string,
  stats: BigIntStats,
  ready: VerifiedCopy[],
  bytesLeft: () => number,
  spend: (bytes: number) => void
): keyof CopiesTally | null {
  if (
    !stats.isFile() ||
    !isInsideHome(args.accountHome, path) ||
    !hasNoLinkBelowHome(args.accountHome, path)
  ) {
    return 'error'
  }
  if (stats.nlink !== 1n) {
    return 'linked'
  }
  // Another user could have it open to write, unseen by any open check.
  if (!onlyOwnerWrites(stats)) {
    return 'open'
  }
  // Written to since the move: an appender that had it open.
  if (trashKey(stats) !== entry.copyKey) {
    return 'changed'
  }
  const original = lstatOrNull(entry.original)
  if (!original?.isFile()) {
    // Codex compressed the original meanwhile: a plain copy is never judged against a `.zst`.
    return lstatOrNull(rolloutTwinPath(entry.original))?.isFile()
      ? 'compressed'
      : 'missing_original'
  }
  if (stats.size > original.size) {
    return 'differs'
  }
  if (Date.now() > args.deadline) {
    return 'deferred'
  }
  const pairKey = `${trashKey(stats)}|${fileKey(original)}`
  const from = entry.progress?.key === pairKey ? entry.progress.matched : 0
  const allowance = Math.min(Number(stats.size) - from, Math.floor((bytesLeft() - 1) / 2))
  if (allowance <= 0 && Number(stats.size) > from) {
    return 'deferred'
  }
  spend(allowance * 2 + 1)
  const result = originalHoldsCopy(path, entry.original, stats.size, {
    from,
    maxBytes: allowance,
    deadline: args.deadline
  })
  const copyAfter = lstatOrNull(path)
  const originalAfter = lstatOrNull(entry.original)
  if (
    !copyAfter ||
    !originalAfter ||
    trashKey(copyAfter) !== trashKey(stats) ||
    fileKey(originalAfter) !== fileKey(original)
  ) {
    // Changed during the read: looked at again next launch.
    return 'deferred'
  }
  if ('partial' in result) {
    entry.progress = { key: pairKey, matched: result.matched }
    return 'deferred'
  }
  if (!result.holds) {
    return 'differs'
  }
  ready.push({
    copy: path,
    original: entry.original,
    copyKey: trashKey(stats),
    originalKey: fileKey(original)
  })
  return null
}

/**
 * Deletes each rechecked copy the open check then cleared, if it and its original are still as the
 * recheck saw them; the trash folder goes once nothing is left in it.
 */
export function deleteTrashedCopies(accountHome: string, copies: VerifiedCopy[]): CopiesTally {
  const tally = emptyTally()
  const trash = trashFolder(accountHome, false)
  const entries = trash ? readEntries(trash) : null
  if (!trash || !entries) {
    tally.error += copies.length
    return tally
  }
  const deleted = new Set<string>()
  for (const copy of copies) {
    try {
      const stats = lstatOrNull(copy.copy)
      const original = lstatOrNull(copy.original)
      if (
        dirname(copy.copy) !== trash ||
        !stats ||
        trashKey(stats) !== copy.copyKey ||
        !original ||
        fileKey(original) !== copy.originalKey ||
        !safeToRemove(accountHome, copy.copy, stats)
      ) {
        tally.changed += 1
        continue
      }
      unlinkSync(copy.copy)
      deleted.add(basename(copy.copy))
      tally.deleted += 1
      tally.bytesReclaimed += Number(stats.size)
    } catch {
      tally.error += 1
    }
  }
  if (deleted.size === 0) {
    return tally
  }
  const left = entries.filter((entry) => !deleted.has(entry.name))
  if (left.length > 0) {
    writeEntries(trash, left)
    return tally
  }
  // Empty: the list goes, then the folder if nothing else is in it.
  try {
    if (readdirSync(trash).every((name) => name === ENTRIES_FILE)) {
      unlinkSync(join(trash, ENTRIES_FILE))
      rmdirSync(trash)
    } else {
      writeEntries(trash, left)
    }
  } catch {
    // Stays for a later launch.
  }
  return tally
}
