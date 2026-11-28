import { type BigIntStats, rmdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { rolloutTwinPath } from '../rollouts/codex-rollout-compressed-twin'
import { originalHoldsCopy } from './codex-account-copy-content'
import { restore } from './codex-account-copies-trash-restore'
import { emptyTally, type CopiesTally } from './codex-account-copies-tally'
import { inTurnOrder, readCursor, takeInTurn, writeCursor } from './codex-account-copies-kept'
import {
  fileKey,
  hasNoLinkBelowHome,
  isInsideHome,
  lstatOrNull,
  onlyOwnerWrites,
  type VerifiedCopy
} from './codex-account-copy-checks'
import {
  busyOnWindows,
  listFiles,
  readList,
  safeToRemove,
  trashFolder,
  TRASH_GRACE_MS,
  writeList,
  type TrashEntry
} from './codex-account-copies-trash-entries'

// Sync file calls on purpose: this runs on the copies cleanup's own worker thread.

// What one launch's open checks and deletes can get through; the rest waits for a later launch.
const MAX_READY_PER_HOME = 5_000

/**
 * Rechecks, with no lock held, each copy that has waited out its grace period: one whose
 * ~/.codex original still holds every byte, both files unchanged, is returned for the caller's
 * open check and `deleteTrashedCopies`; one that no longer qualifies goes back where it was.
 * Only lists already due are read, and only changed ones are written.
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
  if (!trash) {
    return { ready, tally, bytesRead: 0 }
  }
  const now = args.now ?? Date.now()
  const cursor = readCursor(args.accountHome)
  // Due lists in turn after the one the last launch stopped at: a deadline can't hold back the rest.
  const lists = inTurnOrder(
    listFiles(trash).filter((list) => now - list.movedAt >= TRASH_GRACE_MS),
    (list) => list.name,
    cursor.trashWalkAfter
  )
  let lastList: string | undefined
  let cutShort = false
  let bytesRead = 0
  const budget = {
    left: () => args.maxBytes - bytesRead,
    spend: (n: number) => {
      bytesRead += n
    }
  }
  // Passed last launch but not deleted (open, say): offered after fresh copies, without a read.
  const retries: VerifiedCopy[] = []
  for (const list of lists) {
    if (Date.now() > args.deadline) {
      cutShort = true
      tally.deferred += 1
      continue
    }
    lastList = list.name
    const entries = readList(trash, list.name)
    if (!entries) {
      tally.error += 1
      continue
    }
    const next: TrashEntry[] = []
    let changed = false
    // Smallest first: one huge copy can't hold back the rest, and it resumes where it stopped.
    const present = entries
      .map((entry) => ({ entry, path: join(trash, basename(entry.name)) }))
      .map((item) => {
        try {
          return { ...item, stats: lstatOrNull(item.path), failed: false }
        } catch {
          return { ...item, stats: null, failed: true }
        }
      })
      .sort((a, b) => Number((a.stats?.size ?? 0n) - (b.stats?.size ?? 0n)))
    for (const { entry, path, stats, failed } of present) {
      if (failed) {
        // Unreadable right now: kept listed for a later launch.
        tally.error += 1
        next.push(entry)
        continue
      }
      if (!stats) {
        // Listed, but its move never happened (the list is older than any late move).
        changed = true
        continue
      }
      const { progress: progressBefore, passed: passedBefore } = entry
      let reason: keyof CopiesTally | null
      try {
        reason = recheckOne(args, entry, list.name, path, stats, {
          ready: ready.length < MAX_READY_PER_HOME ? ready : null,
          retries,
          budget
        })
      } catch {
        reason = 'error'
      }
      changed ||=
        entry.passed !== passedBefore ||
        entry.progress?.key !== progressBefore?.key ||
        entry.progress?.matched !== progressBefore?.matched
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
          changed = true
          continue
        }
        tally.error += 1
      } catch (error) {
        tally[busyOnWindows(error) ? 'open' : 'error'] += 1
      }
      next.push(entry)
    }
    if (changed) {
      writeList(trash, list.name, next)
    }
  }
  const turn = takeInTurn(
    retries,
    (copy) => basename(copy.copy),
    cursor.trashRetryAfter,
    MAX_READY_PER_HOME - ready.length
  )
  ready.push(...turn.taken)
  tally.deferred += retries.length - turn.taken.length
  writeCursor(args.accountHome, {
    ...cursor,
    trashWalkAfter: cutShort ? (lastList ?? cursor.trashWalkAfter) : undefined,
    trashRetryAfter: turn.next
  })
  return { ready, tally, bytesRead }
}

/**
 * Null: ready, or still due a look (time or bytes ran out); a kept reason: the copy goes back.
 * 'error' and 'deferred' keep it in the trash.
 */
function recheckOne(
  args: { accountHome: string; deadline: number },
  entry: TrashEntry,
  list: string,
  path: string,
  stats: BigIntStats,
  out: {
    /** Null once this launch has enough fresh copies: the rest wait, unread. */
    ready: VerifiedCopy[] | null
    retries: VerifiedCopy[]
    budget: { left: () => number; spend: (bytes: number) => void }
  }
): keyof CopiesTally | null {
  const { ready, budget } = out
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
  // Written to since the move (an appender that had it open), or its key after the move unknown.
  if (!entry.movedKey || fileKey(stats) !== entry.movedKey) {
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
  const pairKey = `${fileKey(stats)}|${fileKey(original)}`
  const copy: VerifiedCopy = {
    copy: path,
    original: entry.original,
    copyKey: fileKey(stats),
    originalKey: fileKey(original),
    list
  }
  // The delete rechecks both keys right before unlinking: unchanged keys mean unchanged bytes.
  if (entry.passed === pairKey) {
    out.retries.push(copy)
    return null
  }
  if (!ready || Date.now() > args.deadline) {
    return 'deferred'
  }
  const from = entry.progress?.key === pairKey ? entry.progress.matched : 0
  const allowance = Math.min(Number(stats.size) - from, Math.floor((budget.left() - 1) / 2))
  if (allowance <= 0 && Number(stats.size) > from) {
    return 'deferred'
  }
  budget.spend(allowance * 2 + 1)
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
    fileKey(copyAfter) !== fileKey(stats) ||
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
  entry.passed = pairKey
  ready.push(copy)
  return null
}

/**
 * The last step for one rechecked copy: unlinked only if it and its original still have the keys
 * that passed. Returns the bytes freed, or null when anything changed (it stays in the trash).
 */
function removeIfStillPassing(
  accountHome: string,
  trash: string,
  copy: VerifiedCopy
): number | null {
  const stats = lstatOrNull(copy.copy)
  const original = lstatOrNull(copy.original)
  if (
    dirname(copy.copy) !== trash ||
    !stats ||
    fileKey(stats) !== copy.copyKey ||
    !original ||
    fileKey(original) !== copy.originalKey ||
    !safeToRemove(accountHome, copy.copy, stats)
  ) {
    return null
  }
  unlinkSync(copy.copy)
  return Number(stats.size)
}

/**
 * Deletes each rechecked copy the open check then cleared, if it and its original are still as the
 * recheck saw them; the trash folder goes once nothing is left in it.
 */
export function deleteTrashedCopies(accountHome: string, copies: VerifiedCopy[]): CopiesTally {
  const tally = emptyTally()
  const trash = trashFolder(accountHome, false)
  if (!trash) {
    tally.error += copies.length
    return tally
  }
  const deletedByList = new Map<string, Set<string>>()
  for (const copy of copies) {
    try {
      const removed = copy.list ? removeIfStillPassing(accountHome, trash, copy) : null
      if (removed === null || copy.list === undefined) {
        tally.changed += 1
        continue
      }
      const deleted = deletedByList.get(copy.list) ?? new Set<string>()
      deleted.add(basename(copy.copy))
      deletedByList.set(copy.list, deleted)
      tally.deleted += 1
      tally.bytesReclaimed += removed
    } catch {
      tally.error += 1
    }
  }
  for (const [list, deleted] of deletedByList) {
    const entries = readList(trash, list)
    if (entries) {
      writeList(
        trash,
        list,
        entries.filter((entry) => !deleted.has(entry.name))
      )
    }
  }
  // Empty: the folder goes; anything else in it keeps it (rmdir fails, unlisted).
  try {
    if (deletedByList.size > 0) {
      rmdirSync(trash)
    }
  } catch {
    // Stays for a later launch.
  }
  return tally
}
