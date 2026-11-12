import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../../../worker-threads/worker-thread-spawn'
import { ORCHESTRATION_JOURNAL_SIZE_LIMIT_BYTES, type OrchestrationDb } from '../orchestration-db'
import { workerOutputCopyRemovalWorkerSource } from './worker-output-copy-removal-worker-source'

const START_DELAY_MS = 30_000
const SAVED_OUTPUT_COPY_INDEX = 'idx_worker_terminal_archives_saved_copy'
// References stay well under 2 KB; saved copies were up to 512 KB.
const SAVED_OUTPUT_COPY_PREDICATE = 'octet_length(content) > 2048'

export type WorkerOutputCopyRemovalOptions = {
  gapMs?: number
}

/** Strip output copies saved by earlier releases down to their reference fields; resolves the rows it rewrote. */
export function runWorkerOutputCopyRemoval(
  filename: string,
  options: WorkerOutputCopyRemovalOptions = {}
): { worker: Worker; finished: Promise<number> } {
  const worker = spawnWorkerThread(workerOutputCopyRemovalWorkerSource, {
    eval: true,
    workerData: {
      filename,
      index: SAVED_OUTPUT_COPY_INDEX,
      copyPredicate: SAVED_OUTPUT_COPY_PREDICATE,
      journalSizeLimit: ORCHESTRATION_JOURNAL_SIZE_LIMIT_BYTES,
      gapMs: options.gapMs ?? 15
    }
  })
  const finished = new Promise<number>((resolve, reject) => {
    let removed = 0
    worker.on('message', (message: { type: string; removed: number }) => {
      removed = message.removed
    })
    worker.on('error', reject)
    worker.on('exit', () => resolve(removed))
  })
  return { worker, finished }
}

/** True until the worker has built its index and found no saved copy behind it. */
export function needsWorkerOutputCopyRemoval(database: OrchestrationDb): boolean {
  const indexed = database.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(SAVED_OUTPUT_COPY_INDEX)
  // Without the index this probe would scan every archive row on the main thread.
  return (
    !indexed ||
    Boolean(
      database.db
        .prepare(
          `SELECT 1 FROM worker_terminal_archives INDEXED BY ${SAVED_OUTPUT_COPY_INDEX}
           WHERE ${SAVED_OUTPUT_COPY_PREDICATE} LIMIT 1`
        )
        .get()
    )
  )
}

/** After startup settles, remove saved output copies off the main thread. */
export function scheduleWorkerOutputCopyRemoval(
  database: OrchestrationDb,
  filename: string,
  isCurrent: () => boolean
): void {
  const timer = setTimeout(() => {
    try {
      if (!isCurrent() || !needsWorkerOutputCopyRemoval(database)) {
        return
      }
      const { worker, finished } = runWorkerOutputCopyRemoval(filename)
      worker.unref()
      // A closed or replaced database stops the rewrite after its current row.
      worker.on('message', () => {
        if (!isCurrent()) {
          void worker.terminate()
        }
      })
      finished.catch((error: unknown) => {
        console.warn('[orchestration] removing saved worker output copies stopped', error)
      })
    } catch (error) {
      console.warn('[orchestration] removing saved worker output copies did not start', error)
    }
  }, START_DELAY_MS)
  timer.unref?.()
}
