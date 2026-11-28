import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../worker-threads/worker-thread-entry-path'
import { withTimeoutResult } from '../../../../shared/concurrency/promise-timeout-fallback'
import type {
  CodexAccountCopiesRequest,
  CodexAccountCopiesResponse
} from './codex-account-copies-worker-protocol'

const WORKER_FILENAME = 'codex-account-copies-worker-entry.js'
const STOP_WAIT_MS = 10_000

export type CodexAccountCopiesWorker = {
  call(request: CodexAccountCopiesRequest): Promise<CodexAccountCopiesResponse>
  /** Ends the worker, waiting a bounded time: for when nothing it does can still matter. */
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
