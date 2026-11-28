import { join } from 'node:path'
import { findOpenFiles } from '../../../filesystem/open-file-check'
import { findFilesWithAcl } from '../../../filesystem/macos-file-acl'
import { distinctFolders } from '../bridges/codex-legacy-session-copy-writer-locks'
import { holdThreadLockFolders, WRITER_LOCKS } from './codex-thread-writer-locks'
import { withTimeoutResult } from '../../../../shared/concurrency/promise-timeout-fallback'
import { addTally, emptyTally, type CopiesTally } from './codex-account-copies-tally'
import type { VerifiedCopy } from './codex-account-copy-checks'
import type { CodexHistoryMoveOutcome } from '../../../telemetry/codex-history-move-telemetry'
import type { CodexAccountCopiesWorker } from './codex-account-copies-worker'
import type { CodexAccountCopiesResponse } from './codex-account-copies-worker-protocol'

// One launch reads at most this much of the copies and their originals; the rest
// waits for later launches, so a heavy history costs a few idle minutes spread over runs.
const MAX_BYTES_PER_LAUNCH = 4 * 1024 ** 3
const MAX_MS_PER_LAUNCH = 3 * 60_000
// Each home's moves get their own time after its comparisons, so a long check still moves.
const MOVE_MS_PER_HOME = 60_000
const GAP_BETWEEN_HOMES_MS = 1_000
// Codex gives up waiting on lock coordination after 30 s; a batch's renames take milliseconds.
const LOCK_HOLD_MS = 10_000
// One lock hold and one `lsof` per batch: Codex waits on coordination for well under a second,
// and no process starts per file.
const OPEN_CHECK_BATCH = 128
// A step outside the locks that hasn't answered this long past its own deadline is on a hung disk.
const STEP_WAIT_MS = 60_000

/**
 * In homes whose history moved into ~/.codex: deletes trashed copies that waited out their grace
 * period and still pass every check, then moves each rollout copy the move left behind whose bytes
 * ~/.codex holds and that no process has open into the home's trash; everything else stays for a
 * later launch. Null when nothing ran: this platform can't tell open files (Linux), or it stopped.
 */
export async function cleanUpCodexAccountCopies(args: {
  homes: string[]
  storeHome: string
  /**
   * The home's move outcome this run, asked before each step; null once it is no longer shared or
   * a pass is due. Stuck homes (busy, refused, incomplete, failed) keep every file.
   */
  moveOutcome: (accountHome: string) => CodexHistoryMoveOutcome | null
  shouldStop: () => boolean
  worker: CodexAccountCopiesWorker
  findOpen?: typeof findOpenFiles
  /** Holds Codex's lock coordination in these folders; null when it can't be taken. */
  holdLocks?: typeof holdThreadLockFolders
  findAcl?: typeof findFilesWithAcl
  /** The longest Codex's lock coordination is held for one batch, whatever the disk does. */
  lockHoldMs?: number
  /** How long a step outside the locks may run past its deadline before the run is abandoned. */
  stepWaitMs?: number
  /** Called after any batch deleted a copy, so a stop midway still refreshes disk usage. */
  onDeleted?: () => void
  platform?: NodeJS.Platform
  /** This Orca's version; each home settled under it is skipped. */
  version: string
  /** Where Orca keeps account homes: the worker confirms each home is one of them. */
  managedAccountsRoot: string
}): Promise<(CopiesTally & { homes: number }) | null> {
  const platform = args.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'win32') {
    return null
  }
  const moved = (home: string): boolean => args.moveOutcome(home) === 'moved'
  const findOpen = args.findOpen ?? findOpenFiles
  const holdLocks = args.holdLocks ?? holdThreadLockFolders
  const findAcl = async (paths: string[]): Promise<Set<string> | null> =>
    platform === 'darwin' ? (args.findAcl ?? findFilesWithAcl)(paths) : new Set()
  const lockHoldMs = args.lockHoldMs ?? LOCK_HOLD_MS
  const stepWaitMs = args.stepWaitMs ?? STEP_WAIT_MS
  // A step that never answers ends this launch's run (the worker too); the next launch retries.
  const settle = async <T>(work: Promise<T>, by = Date.now()): Promise<{ value: T } | null> => {
    const result = await withTimeoutResult(work, Math.max(0, by - Date.now()) + stepWaitMs)
    if (result.ok) {
      return { value: result.value }
    }
    void args.worker.stop()
    return null
  }
  const total = { ...emptyTally(), homes: 0 }
  const deadline = Date.now() + MAX_MS_PER_LAUNCH
  let bytesLeft = MAX_BYTES_PER_LAUNCH
  const warn = (answer: CodexAccountCopiesResponse, what: string): void => {
    console.warn(
      `[codex-account-history] Old copies were not ${what}:`,
      answer.ok ? answer.op : answer.message
    )
    total.error += 1
  }
  for (const accountHome of args.homes) {
    if (args.shouldStop()) {
      return null
    }
    if (!moved(accountHome)) {
      continue
    }
    if (bytesLeft === 0 || Date.now() > deadline) {
      // Later homes wait for a later launch.
      total.deferred += 1
      break
    }
    // Trash past its grace period first, with no lock held: nothing Codex waits on.
    const recheckAnswer = await settle(
      args.worker.call({
        op: 'recheck-trash',
        accountHome,
        storeHome: args.storeHome,
        managedAccountsRoot: args.managedAccountsRoot,
        maxBytes: bytesLeft,
        deadline
      }),
      deadline
    )
    if (!recheckAnswer || args.shouldStop()) {
      return null
    }
    const rechecked = recheckAnswer.value
    if (!rechecked.ok || rechecked.op !== 'recheck-trash') {
      warn(rechecked, 'rechecked')
      continue
    }
    bytesLeft = Math.max(0, bytesLeft - rechecked.bytesRead)
    addTally(total, rechecked.tally)
    for (let start = 0; start < rechecked.ready.length; start += OPEN_CHECK_BATCH) {
      const batch = rechecked.ready.slice(start, start + OPEN_CHECK_BATCH)
      if (Date.now() > deadline || !moved(accountHome)) {
        total.deferred += rechecked.ready.length - start
        break
      }
      const paths = batch.map((copy) => copy.copy)
      const probe = await settle(findOpen(paths, { shouldStop: args.shouldStop }))
      const aclProbe = probe?.value ? await settle(findAcl(paths)) : { value: null }
      if (!probe || !aclProbe || args.shouldStop()) {
        return null
      }
      const open = probe.value
      const withAcl = aclProbe.value
      if (!open || !withAcl) {
        // The checks can't answer now: the rest waits for a later launch, not one probe each.
        total.open += rechecked.ready.length - start
        break
      }
      const closed = batch.filter((copy) => !open.has(copy.copy) && !withAcl.has(copy.copy))
      total.open += batch.length - closed.length
      if (closed.length === 0) {
        continue
      }
      const deleteAnswer = await settle(
        args.worker.call({ op: 'delete-trashed', accountHome, copies: closed })
      )
      const deleted = deleteAnswer?.value
      // Before the stop check, and also when the answer is lost (a stop or a timeout cut the batch
      // short): files it may have deleted still leave disk usage.
      if (!deleted?.ok || (deleted.op === 'delete-trashed' && deleted.tally.deleted > 0)) {
        args.onDeleted?.()
      }
      if (!deleted || args.shouldStop()) {
        return null
      }
      if (!deleted.ok || deleted.op !== 'delete-trashed') {
        warn(deleted, 'deleted')
        continue
      }
      addTally(total, deleted.tally)
    }
    const verifyAnswer = await settle(
      args.worker.call({
        op: 'verify',
        accountHome,
        storeHome: args.storeHome,
        budget: { maxBytes: bytesLeft, deadline },
        version: args.version,
        managedAccountsRoot: args.managedAccountsRoot
      }),
      deadline
    )
    if (!verifyAnswer || args.shouldStop()) {
      return null
    }
    const checked = verifyAnswer.value
    if (!checked.ok || checked.op !== 'verify') {
      warn(checked, 'checked')
      continue
    }
    total.homes += 1
    bytesLeft = Math.max(0, bytesLeft - checked.bytesRead)
    addTally(total, checked.tally)
    // The account's lock folder is linked to the store's once its history moved: one folder.
    const moveDeadline = Date.now() + MOVE_MS_PER_HOME
    let trashedHere = 0
    // Noted once per home after its batches: the note rewrites the home's kept-copies record.
    const aclKeptHere: VerifiedCopy[] = []
    const folders = await settle(
      distinctFolders([join(args.storeHome, WRITER_LOCKS), join(accountHome, WRITER_LOCKS)])
    )
    if (!folders) {
      return null
    }
    const lockFolders = folders.value
    for (let start = 0; start < checked.verified.length; start += OPEN_CHECK_BATCH) {
      if (args.shouldStop()) {
        return null
      }
      const batch = checked.verified.slice(start, start + OPEN_CHECK_BATCH)
      if (!moved(accountHome) || Date.now() > moveDeadline) {
        total.deferred += batch.length
        continue
      }
      // macOS: an ACL can let another user write without any mode bit, and lsof can't see them.
      // Checked before the hold, so Codex never waits on it; the trash's recheck looks again.
      const aclProbe = await settle(findAcl(batch.map((copy) => copy.copy)))
      if (!aclProbe) {
        return null
      }
      const withAcl = aclProbe.value
      if (!withAcl) {
        total.open += checked.verified.length - start
        break
      }
      aclKeptHere.push(...batch.filter((copy) => withAcl.has(copy.copy)))
      const candidates = batch.filter((copy) => !withAcl.has(copy.copy))
      total.open += batch.length - candidates.length
      if (candidates.length === 0) {
        continue
      }
      // While coordination is held no Codex can take a thread lock, so the open check and the
      // moves that follow see every writer that matters: none can start meanwhile.
      const taking = holdLocks(lockFolders)
      const held = await settle(taking)
      if (!held) {
        // A hold that still arrives later is let go at once.
        void taking.then((late) => late?.release()).catch(() => {})
        return null
      }
      const hold = held.value
      if (!hold) {
        total.busy += candidates.length
        continue
      }
      // Everything under the hold shares one deadline, the open check included: a stalled disk
      // can delay a step, never the release.
      const releaseBy = Date.now() + lockHoldMs
      let stuck = false
      try {
        const probe = await withTimeoutResult(
          findOpen(
            candidates.map((copy) => copy.copy),
            { shouldStop: args.shouldStop }
          ),
          lockHoldMs
        )
        if (!probe.ok) {
          stuck = true
          return null
        }
        if (args.shouldStop()) {
          return null
        }
        const open = probe.value
        if (!open) {
          total.open += checked.verified.length - start
          break
        }
        const closed =
          hold.stillHeld() && moved(accountHome)
            ? candidates.filter((copy) => !open.has(copy.copy))
            : []
        total.open += candidates.length - closed.length
        const timeLeft = releaseBy - Date.now()
        if (closed.length === 0) {
          continue
        }
        if (timeLeft <= 0) {
          total.deferred += closed.length
          continue
        }
        const answer = await withTimeoutResult(
          args.worker.call({ op: 'trash', accountHome, copies: closed, lockFolders }),
          timeLeft
        )
        if (!answer.ok) {
          // A move stuck on a hung disk: the locks go now, so Codex never waits on it. A rename
          // that still lands later loses nothing, and the trash is checked again before deleting.
          stuck = true
          return null
        }
        const trashed = answer.value
        if (!trashed.ok || trashed.op !== 'trash') {
          warn(trashed, 'moved')
          continue
        }
        addTally(total, trashed.tally)
        trashedHere += trashed.tally.trashed
      } finally {
        if (stuck) {
          // Ended first, so a move still under way can't start the next rename after the release.
          void args.worker.stop()
        }
        await hold.release()
      }
    }
    if (
      aclKeptHere.length > 0 &&
      !args.shouldStop() &&
      !(await settle(args.worker.call({ op: 'remember-acl', accountHome, copies: aclKeptHere })))
    ) {
      return null
    }
    // Once per home and outside the locks: empty folders only, so Codex never waits on the walk.
    if (
      trashedHere > 0 &&
      !args.shouldStop() &&
      !(await settle(args.worker.call({ op: 'prune', accountHome, storeHome: args.storeHome })))
    ) {
      return null
    }
    await new Promise((resolve) => setTimeout(resolve, GAP_BETWEEN_HOMES_MS).unref?.())
  }
  return total
}
