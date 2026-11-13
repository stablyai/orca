// Existing history is compacted once, on a worker thread with its own connection; new writes stay compact.

import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../worker-threads/worker-thread-entry-path'
import { journalDatabasePath, type JournalHostDatabase } from '../database/journal-host-database'
import type { StructuredAgentSessionLogger } from '../../agent-session-wire/host/structured-agent-session-logger'

const WORKER_FILENAME = 'journal-item-compaction-worker-entry.js'
const FIRST_RUN_DELAY_MS = 2 * 60_000

type CompactionResult =
  | { ok: true; deleted: number; freedBytes: number }
  | { ok: false; error: string }

export function startJournalItemCompaction(deps: {
  database: Pick<
    JournalHostDatabase,
    'readOnly' | 'isClosed' | 'stateDirectory' | 'compactionActivity'
  >
  logger: StructuredAgentSessionLogger
}): { stop: () => void } {
  let worker: Worker | null = null
  let stopped = false
  const timer = setTimeout(() => {
    try {
      // A finished pass is recorded in the database; the worker's first page sees it and exits.
      if (stopped || deps.database.readOnly || deps.database.isClosed) {
        return
      }
      const databasePath = journalDatabasePath(deps.database.stateDirectory)
      worker = spawnCompactionWorker(databasePath, deps.database.compactionActivity.buffer)
      worker.on('message', (result: CompactionResult) => {
        if (!result.ok) {
          deps.logger.warn('old chat history could not be compacted', {
            scope: 'journal-item-compaction',
            error: result.error
          })
          return
        }
        if (result.deleted === 0) {
          return
        }
        console.info('[agent-session-journal] compacted old chat history', {
          deletedRecords: result.deleted,
          freedBytes: result.freedBytes
        })
      })
      worker.on('error', (error) =>
        deps.logger.warn('chat history compaction worker failed', {
          scope: 'journal-item-compaction',
          error
        })
      )
      worker.on('exit', () => {
        worker = null
      })
      worker.unref()
    } catch (error) {
      deps.logger.warn('chat history compaction could not start', {
        scope: 'journal-item-compaction',
        error
      })
    }
  }, FIRST_RUN_DELAY_MS)
  timer.unref()
  return {
    stop: () => {
      stopped = true
      clearTimeout(timer)
      // A page is one transaction; ending mid-page rolls it back and the next launch resumes.
      void worker?.terminate()
      worker = null
    }
  }
}

function spawnCompactionWorker(databasePath: string, activityBuffer: ArrayBufferLike): Worker {
  // A missing entry surfaces as the worker's error event.
  const path = resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_FILENAME)
  return spawnWorkerThread(path, { workerData: { databasePath, activityBuffer } })
}
