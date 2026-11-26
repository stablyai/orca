import { setTimeout, clearTimeout } from 'node:timers'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import type { WorkerRequestTransport } from '../../../worker-threads/worker-thread-transport'
import { journalCheckpointWorkerSource } from './journal-checkpoint-worker-source'
import { JOURNAL_SIZE_LIMIT_BYTES } from './journal-database'

export const JOURNAL_CHECKPOINT_FRAMES = 1000
const CHECKPOINT_RETRY_MS = 100
const CHECKPOINT_PINNED_RETRY_MS = 1000
const STOP_TIMEOUT_MS = 5000

export function spawnJournalCheckpointWorker(filename: string): WorkerRequestTransport {
  return spawnWorkerThread(journalCheckpointWorkerSource, {
    name: 'orca-journal-checkpoint',
    eval: true,
    workerData: {
      filename,
      frames: JOURNAL_CHECKPOINT_FRAMES,
      retryMs: CHECKPOINT_RETRY_MS,
      pinnedRetryMs: CHECKPOINT_PINNED_RETRY_MS,
      sizeLimit: JOURNAL_SIZE_LIMIT_BYTES
    }
  })
}

/** One warning per owner: restarts and fallbacks after the first stay quiet. */
export function journalCheckpointWarning(): (error: unknown) => void {
  let warned = false
  return (error) => {
    if (warned) {
      return
    }
    warned = true
    try {
      console.warn(
        '[agent-session-journal] checkpoint worker unavailable; writer checkpoints until it restarts',
        error
      )
    } catch {
      // A diagnostic must never turn a committed write into an apparent failure.
    }
  }
}

/** Asks the thread to close its connection, terminates it after a bounded wait, and resolves only once it exited. */
export async function stopJournalCheckpointWorker(
  worker: WorkerRequestTransport,
  exited: Promise<void>
): Promise<void> {
  try {
    worker.postMessage({ type: 'stop' })
  } catch {
    // terminate below still ends it.
  }
  const timeout = setTimeout(() => {
    void worker.terminate().catch(() => {})
  }, STOP_TIMEOUT_MS)
  try {
    // Callers hand the database on once close returns, so wait for the thread itself.
    await exited
  } finally {
    clearTimeout(timeout)
  }
}
