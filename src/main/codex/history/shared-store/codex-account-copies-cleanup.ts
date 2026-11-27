import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../worker-threads/worker-thread-entry-path'
import { join } from 'node:path'
import { findOpenFiles } from '../../../filesystem/open-file-check'
import { findFilesWithAcl } from '../../../filesystem/macos-file-acl'
import { distinctFolders } from '../bridges/codex-legacy-session-copy-writer-locks'
import { holdThreadLockFolders, WRITER_LOCKS } from './codex-thread-writer-locks'
import { withTimeoutResult } from '../../../../shared/concurrency/promise-timeout-fallback'
import { addTally, emptyTally, type CopiesTally } from './codex-account-copies-tally'
import type { VerifiedCopy } from './codex-account-copies-delete'
import type { CodexHistoryMoveOutcome } from '../../../telemetry/codex-history-move-telemetry'
import type {
  CodexAccountCopiesRequest,
  CodexAccountCopiesResponse
} from './codex-account-copies-worker-protocol'

const WORKER_FILENAME = 'codex-account-copies-worker-entry.js'
// One launch reads at most this much of the copies and their originals; the rest
// waits for later launches, so a heavy history costs a few idle minutes spread over runs.
const MAX_BYTES_PER_LAUNCH = 4 * 1024 ** 3
const MAX_MS_PER_LAUNCH = 3 * 60_000
// Each home's deletes get their own time after its comparisons, so a long check still deletes.
const DELETE_MS_PER_HOME = 60_000
const GAP_BETWEEN_HOMES_MS = 1_000
const STOP_WAIT_MS = 10_000
// Codex gives up waiting on lock coordination after 30 s; a batch's deletes take milliseconds.
const DELETE_CALL_TIMEOUT_MS = 10_000
// One lock hold and one `lsof` per batch: Codex waits on coordination for well under a second,
// and no process starts per file.
const OPEN_CHECK_BATCH = 128

export type CodexAccountCopiesWorker = {
  call(request: CodexAccountCopiesRequest): Promise<CodexAccountCopiesResponse>
  /** Ends the worker, waiting a bounded time: for when nothing it does can still matter. */
  stop(): Promise<void>
  /** Ends the worker and resolves only once its thread has exited, however long that takes. */
  retire(): Promise<void>
}

export function startCodexAccountCopiesWorker(): CodexAccountCopiesWorker {
  const worker: Worker = spawnWorkerThread(
    resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_FILENAME),
    { name: 'orca-codex-account-copies' }
  )
  let failure: Error | null = null
  let pending: ((response: CodexAccountCopiesResponse) => void) | null = null
  const fail = (error: Error): void => {
    failure ??= error
    pending?.({ ok: false, message: failure.message })
    pending = null
  }
  worker.on('message', (response: CodexAccountCopiesResponse) => {
    pending?.(response)
    pending = null
  })
  worker.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))))
  worker.on('exit', (code) => fail(new Error(`Codex account copies worker exited (${code})`)))
  return {
    call: (request) =>
      failure
        ? Promise.resolve({ ok: false, message: failure.message })
        : new Promise((resolve) => {
            pending = resolve
            worker.postMessage(request)
          }),
    stop: async () => {
      fail(new Error('Codex account copies cleanup stopped'))
      // A worker stuck in a read on a hung mount never exits; a pass must not wait on it.
      await withTimeoutResult(worker.terminate(), STOP_WAIT_MS)
    },
    retire: async () => {
      fail(new Error('Codex account copies cleanup stopped'))
      // Resolves on the thread's exit, after any filesystem call it was inside returns.
      await worker.terminate()
    }
  }
}

/**
 * Deletes, in homes whose history moved into ~/.codex, each rollout copy the move left behind
 * whose bytes ~/.codex holds and that no process has open; everything else stays for a later
 * launch. Null when nothing ran: this platform can't tell open files (Linux), or it stopped.
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
  deleteTimeoutMs?: number
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
  const findAcl = args.findAcl ?? findFilesWithAcl
  const total = { ...emptyTally(), homes: 0 }
  const deadline = Date.now() + MAX_MS_PER_LAUNCH
  let bytesLeft = MAX_BYTES_PER_LAUNCH
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
    const checked = await args.worker.call({
      op: 'verify',
      accountHome,
      storeHome: args.storeHome,
      budget: { maxBytes: bytesLeft, deadline, admitOversized: bytesLeft === MAX_BYTES_PER_LAUNCH },
      version: args.version,
      managedAccountsRoot: args.managedAccountsRoot
    })
    if (!checked.ok || checked.op !== 'verify') {
      if (args.shouldStop()) {
        return null
      }
      console.warn(
        '[codex-account-history] Old copies were not checked:',
        checked.ok ? checked.op : checked.message
      )
      total.error += 1
      continue
    }
    total.homes += 1
    bytesLeft = Math.max(0, bytesLeft - checked.bytesRead)
    addTally(total, checked.tally)
    // The account's lock folder is linked to the store's once its history moved: one folder.
    const deleteDeadline = Date.now() + DELETE_MS_PER_HOME
    let deletedHere = 0
    const lockFolders = await distinctFolders([
      join(args.storeHome, WRITER_LOCKS),
      join(accountHome, WRITER_LOCKS)
    ])
    for (let start = 0; start < checked.verified.length; start += OPEN_CHECK_BATCH) {
      if (args.shouldStop()) {
        return null
      }
      const batch = checked.verified.slice(start, start + OPEN_CHECK_BATCH)
      const aclKept: VerifiedCopy[] = []
      if (!moved(accountHome) || Date.now() > deleteDeadline) {
        total.deferred += batch.length
        continue
      }
      // While coordination is held no Codex can take a thread lock, so the open check and the
      // unlinks that follow see every writer that matters: none can start meanwhile.
      const hold = await holdLocks(lockFolders)
      if (!hold) {
        total.busy += batch.length
        continue
      }
      try {
        const open = await findOpen(
          batch.map((copy) => copy.copy),
          { shouldStop: args.shouldStop }
        )
        // macOS: an ACL can let another user write without any mode bit, and lsof can't see them.
        const withAcl =
          open && platform === 'darwin'
            ? await findAcl(batch.map((copy) => copy.copy))
            : new Set<string>()
        if (args.shouldStop()) {
          return null
        }
        const closed =
          open && withAcl && hold.stillHeld() && moved(accountHome)
            ? batch.filter((copy) => !open.has(copy.copy) && !withAcl.has(copy.copy))
            : []
        total.open += batch.length - closed.length
        // Noted after the hold is let go: it rewrites a file, and only ever saves later work.
        aclKept.push(...(withAcl ? batch.filter((copy) => withAcl.has(copy.copy)) : []))
        if (closed.length === 0) {
          continue
        }
        const answer = await withTimeoutResult(
          args.worker.call({
            op: 'delete',
            accountHome,
            storeHome: args.storeHome,
            copies: closed,
            lockFolders
          }),
          args.deleteTimeoutMs ?? DELETE_CALL_TIMEOUT_MS
        )
        if (!answer.ok) {
          // A delete stuck on a hung mount: the hold lasts until the worker has really exited
          // (finally), since an unlink already under way can still complete. Codex waits as long.
          await args.worker.retire()
          return null
        }
        const deleted = answer.value
        if (deleted.ok && deleted.op === 'delete') {
          addTally(total, deleted.tally)
          deletedHere += deleted.tally.deleted
          if (deleted.tally.deleted > 0) {
            args.onDeleted?.()
          }
        } else {
          if (args.shouldStop()) {
            return null
          }
          total.error += closed.length
        }
      } finally {
        await hold.release()
        // In `finally` so a batch that deletes nothing (`continue`) still notes them.
        if (aclKept.length > 0) {
          await args.worker.call({ op: 'remember-acl', accountHome, copies: aclKept })
        }
      }
    }
    // Once per home and outside the locks: empty folders only, so Codex never waits on the walk.
    if (deletedHere > 0 && !args.shouldStop()) {
      await args.worker.call({ op: 'prune', accountHome, storeHome: args.storeHome })
    }
    await new Promise((resolve) => setTimeout(resolve, GAP_BETWEEN_HOMES_MS).unref?.())
  }
  return total
}
