import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../worker-threads/worker-thread-entry-path'
import { findOpenFiles } from '../../../filesystem/open-file-check'
import { withTimeoutResult } from '../../../../shared/concurrency/promise-timeout-fallback'
import { addTally, emptyTally, type CopiesTally } from './codex-account-copies-tally'
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
const GAP_BETWEEN_HOMES_MS = 1_000
const STOP_WAIT_MS = 10_000
// One `lsof` per batch: the window between a copy's open check and its unlink stays a fraction of
// a second, without a process per file.
const OPEN_CHECK_BATCH = 64

export type CodexAccountCopiesWorker = {
  call(request: CodexAccountCopiesRequest): Promise<CodexAccountCopiesResponse>
  stop(): Promise<void>
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
    for (let start = 0; start < checked.verified.length; start += OPEN_CHECK_BATCH) {
      const batch = checked.verified.slice(start, start + OPEN_CHECK_BATCH)
      // The open check runs right before its batch's unlinks; a pass due meanwhile keeps them all.
      const open = moved(accountHome)
        ? await findOpen(
            batch.map((copy) => copy.copy),
            { shouldStop: args.shouldStop }
          )
        : null
      if (args.shouldStop()) {
        return null
      }
      const closed = open && moved(accountHome) ? batch.filter((copy) => !open.has(copy.copy)) : []
      total.open += batch.length - closed.length
      if (closed.length === 0) {
        continue
      }
      const deleted = await args.worker.call({
        op: 'delete',
        accountHome,
        storeHome: args.storeHome,
        copies: closed
      })
      if (deleted.ok && deleted.op === 'delete') {
        addTally(total, deleted.tally)
      } else {
        if (args.shouldStop()) {
          return null
        }
        total.error += closed.length
      }
    }
    await new Promise((resolve) => setTimeout(resolve, GAP_BETWEEN_HOMES_MS).unref?.())
  }
  return total
}
