import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { PROFILE_STATE_WRITER_AWAIT_INITIALIZATION } from './profile-state-writer-protocol'
import { resolveProfileStateWriterWorkerPath } from './profile-state-writer-worker-path'

/** An unclaimed thread is discarded after this long; a host that never opens its store frees it. */
const PREWARMED_WRITER_TTL_MS = 30_000

type PrewarmedWriter = {
  workerPath: string
  worker: Worker
  failed: boolean
  release: () => void
}

let prewarmed: PrewarmedWriter | null = null

/**
 * Starts the profile writer thread now (~40 ms of thread and module startup), so the store's
 * writer adopts a booted thread instead of waiting for one. Best effort: on any failure the
 * writer starts its own thread as before.
 */
export function prewarmProfileStateWriterThread(
  workerPath: string = resolveProfileStateWriterWorkerPath()
): void {
  if (prewarmed) {
    return
  }
  let worker: Worker
  try {
    worker = spawnWorkerThread(workerPath, {
      workerData: PROFILE_STATE_WRITER_AWAIT_INITIALIZATION,
      execArgv: []
    })
  } catch {
    return
  }
  const entry: PrewarmedWriter = { workerPath, worker, failed: false, release: () => {} }
  const fail = (): void => {
    entry.failed = true
  }
  const expiry = setTimeout(() => {
    if (prewarmed === entry) {
      prewarmed = null
      entry.release()
      void worker.terminate().catch(() => {})
    }
  }, PREWARMED_WRITER_TTL_MS)
  expiry.unref()
  entry.release = () => {
    clearTimeout(expiry)
    worker.off('error', fail)
    worker.off('exit', fail)
  }
  worker.on('error', fail)
  worker.on('exit', fail)
  // Unclaimed, it must not keep the process alive.
  worker.unref()
  prewarmed = entry
}

/** The prewarmed thread for this entry if it is still healthy; otherwise null (spawn one). */
export function takePrewarmedProfileStateWriterThread(workerPath: string): Worker | null {
  const entry = prewarmed
  if (!entry) {
    return null
  }
  prewarmed = null
  entry.release()
  if (entry.failed || entry.workerPath !== workerPath) {
    void entry.worker.terminate().catch(() => {})
    return null
  }
  entry.worker.ref()
  return entry.worker
}
