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
// One launch reads at most this much of the copies (and as much of their originals); the rest
// waits for later launches, so a heavy history costs a few idle minutes spread over runs.
const MAX_BYTES_PER_LAUNCH = 4 * 1024 ** 3
const MAX_MS_PER_LAUNCH = 3 * 60_000
const GAP_BETWEEN_HOMES_MS = 1_000
const STOP_WAIT_MS = 10_000

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
    const checked = await args.worker.call({
      op: 'verify',
      accountHome,
      storeHome: args.storeHome,
      budget: { maxBytes: bytesLeft, deadline },
      version: args.version
    })
    if (!checked.ok) {
      if (args.shouldStop()) {
        return null
      }
      console.warn('[codex-account-history] Old copies were not checked:', checked.message)
      total.error += 1
      continue
    }
    if (checked.op !== 'verify') {
      total.error += 1
      continue
    }
    total.homes += 1
    bytesLeft = Math.max(0, bytesLeft - checked.bytesRead)
    addTally(total, checked.tally)
    if (checked.verified.length === 0 || !moved(accountHome) || args.shouldStop()) {
      total.open += moved(accountHome) ? 0 : checked.verified.length
      continue
    }
    const held = await args.worker.call({ op: 'hold', accountHome, copies: checked.verified })
    if (!held.ok || held.op !== 'hold') {
      // Stopped or failed: whatever it held goes back on the next launch's check.
      if (args.shouldStop()) {
        return null
      }
      total.error += checked.verified.length
      continue
    }
    addTally(total, held.tally)
    if (held.held.length === 0) {
      continue
    }
    const open = await findOpen(
      held.held.map((copy) => copy.held),
      { shouldStop: args.shouldStop }
    )
    // A pass started meanwhile, or the check couldn't tell: every held copy goes back.
    const finished = await args.worker.call({
      op: 'finish',
      accountHome,
      storeHome: args.storeHome,
      held: held.held,
      open: open && moved(accountHome) && !args.shouldStop() ? open : null
    })
    if (finished.ok && finished.op === 'finish') {
      addTally(total, finished.tally)
    } else {
      if (args.shouldStop()) {
        return null
      }
      total.error += held.held.length
    }
    await new Promise((resolve) => setTimeout(resolve, GAP_BETWEEN_HOMES_MS).unref?.())
  }
  return total
}
