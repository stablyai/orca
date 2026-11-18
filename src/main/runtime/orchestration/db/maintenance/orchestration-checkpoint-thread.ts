import { spawnWorkerThread } from '../../../../worker-threads/worker-thread-spawn'
import type { OrchestrationDb } from '../orchestration-db'

// Prompt while writes land; slower while the WAL stays empty, so an idle database barely wakes it.
const CHECKPOINT_BUSY_INTERVAL_MS = 250
const CHECKPOINT_IDLE_INTERVAL_MS = 5000
// Main checkpoints only if the thread falls this far behind (~40 MiB of 4 KiB pages), so the WAL stays bounded.
export const MAIN_CHECKPOINT_BACKSTOP_PAGES = 10_000

// Evaluated source, as the chat journal's checkpoint worker: a passive checkpoint never blocks the writer.
const checkpointWorkerSource = `
const { workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.filename);
if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') {
  throw new Error('orchestration database is not in WAL mode');
}
db.exec('PRAGMA busy_timeout = 1000;');
const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
let failures = 0;
let interval = workerData.busyMs;
const tick = () => {
  try {
    const { log } = checkpoint.get();
    failures = 0;
    interval = log > 0 ? workerData.busyMs : Math.min(interval * 2, workerData.idleMs);
  } catch (error) {
    // Exiting hands checkpoints back to main rather than letting the WAL grow.
    if (++failures >= 3) throw error;
  }
  setTimeout(tick, interval);
};
setTimeout(tick, interval);
`

/**
 * For as long as the database is open, checkpoints the WAL on a worker thread instead of in main's
 * commits: an auto-checkpointing commit fsyncs the whole file, which blocked main for up to 934 ms on
 * a busy disk and turned single-row status writes into half-second stalls. Main keeps only a far
 * backstop. Returns the undo; a worker that fails or exits hands checkpoints back to main at once.
 */
export function checkpointOffMainThread({ db }: OrchestrationDb): () => void {
  const main = db
    .prepare('PRAGMA database_list')
    .all()
    .find((row) => row.name === 'main')
  const filename = typeof main?.file === 'string' ? main.file : ''
  if (!filename) {
    return () => {}
  }
  const previous = Number(db.pragma('wal_autocheckpoint', { simple: true }))
  let worker: ReturnType<typeof spawnWorkerThread>
  try {
    worker = spawnWorkerThread(checkpointWorkerSource, {
      name: 'orca-orchestration-checkpoint',
      eval: true,
      workerData: {
        filename,
        busyMs: CHECKPOINT_BUSY_INTERVAL_MS,
        idleMs: CHECKPOINT_IDLE_INTERVAL_MS
      }
    })
  } catch {
    return () => {}
  }
  let restored = false
  const restore = (): void => {
    if (!restored) {
      restored = true
      try {
        db.pragma(`wal_autocheckpoint = ${previous}`)
      } catch {
        // A closed database has no threshold left to restore.
      }
    }
  }
  worker.on('error', restore)
  worker.on('exit', restore)
  worker.unref()
  db.pragma(`wal_autocheckpoint = ${MAIN_CHECKPOINT_BACKSTOP_PAGES}`)
  return () => {
    worker.terminate().catch(() => {})
    restore()
  }
}
