import { type BigIntStats, linkSync, lstatSync, mkdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { rolloutTwinPath } from '../rollouts/codex-rollout-compressed-twin'
import { originalHoldsCopy } from './codex-account-copy-content'
import { emptyTally, type CopiesTally } from './codex-account-copies-tally'
import { readKeptCopies, takeInTurn, writeKeptCopies } from './codex-account-copies-kept'
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
  listFiles,
  readList,
  RESTORE_ROOT,
  safeToRemove,
  trashFolder,
  TRASH_GRACE_MS,
  writeList,
  type TrashEntry
} from './codex-account-copies-trash-entries'

// Sync file calls on purpose: this runs on the copies cleanup's own worker thread.

// What one launch's open checks and deletes can get through; the rest waits for a later launch.
const MAX_READY_PER_HOME = 5_000

/** Makes each missing folder of `parts` under the home, one level at a time; false on a link. */
function makeFolders(accountHome: string, parts: string[]): boolean {
  let current = accountHome
  for (const part of parts) {
    current = join(current, part)
    if (!lstatOrNull(current)) {
      mkdirSync(current)
    }
    const stats = lstatSync(current)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return false
    }
  }
  return true
}

/**
 * Puts a copy back where it was, never over another file (a hard link fails on one that exists);
 * false when that place is taken or isn't safely inside the home.
 */
function restore(accountHome: string, path: string, entry: TrashEntry): boolean {
  const parts = entry.from.split('/')
  if (!RESTORE_ROOT.test(parts[0]) || parts.some((part) => part === '' || part === '..')) {
    return false
  }
  const target = join(accountHome, ...parts)
  const there = lstatOrNull(target)
  const here = lstatOrNull(path)
  // A restore cut short after its link: both names hold the same file.
  if (there && here && there.dev === here.dev && there.ino === here.ino) {
    unlinkSync(path)
    return true
  }
  if (there || !makeFolders(accountHome, parts.slice(0, -1))) {
    return false
  }
  if (!hasNoLinkBelowHome(accountHome, dirname(target)) || !isInsideHome(accountHome, target)) {
    return false
  }
  linkSync(path, target)
  unlinkSync(path)
  return true
}

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
  const lists = listFiles(trash)
    .filter((list) => now - list.movedAt >= TRASH_GRACE_MS)
    .sort((a, b) => a.movedAt - b.movedAt)
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
      tally.deferred += 1
      continue
    }
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
      .map((item) => ({ ...item, stats: lstatOrNull(item.path) }))
      .sort((a, b) => Number((a.stats?.size ?? 0n) - (b.stats?.size ?? 0n)))
    for (const { entry, path, stats } of present) {
      if (!stats) {
        // Listed, but its move never happened (the list is older than any late move).
        changed = true
        continue
      }
      const before = `${entry.progress?.matched}|${entry.passed}`
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
      changed ||= `${entry.progress?.matched}|${entry.passed}` !== before
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
  const record = readKeptCopies(args.accountHome)
  const turn = takeInTurn(
    retries,
    (copy) => basename(copy.copy),
    record.trashRetryAfter,
    MAX_READY_PER_HOME - ready.length
  )
  ready.push(...turn.taken)
  tally.deferred += retries.length - turn.taken.length
  if (turn.next !== record.trashRetryAfter) {
    writeKeptCopies(args.accountHome, { ...record, trashRetryAfter: turn.next })
  }
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
  const pairKey = `${trashKey(stats)}|${fileKey(original)}`
  const copy: VerifiedCopy = {
    copy: path,
    original: entry.original,
    copyKey: trashKey(stats),
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
  entry.passed = pairKey
  ready.push(copy)
  return null
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
      const stats = lstatOrNull(copy.copy)
      const original = lstatOrNull(copy.original)
      if (
        !copy.list ||
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
      const deleted = deletedByList.get(copy.list) ?? new Set<string>()
      deleted.add(basename(copy.copy))
      deletedByList.set(copy.list, deleted)
      tally.deleted += 1
      tally.bytesReclaimed += Number(stats.size)
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
