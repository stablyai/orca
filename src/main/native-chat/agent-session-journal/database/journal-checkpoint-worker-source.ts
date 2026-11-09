// Evaluated source travels with both host bundles, without a separate worker entry or Electron imports.
export const journalCheckpointWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { statSync } = require('node:fs');
let db;
let idle;
try {
  db = new DatabaseSync(workerData.filename);
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') {
    throw new Error('chat journal is not in WAL mode');
  }
  db.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; PRAGMA checkpoint_fullfsync = ON;');
  db.exec('PRAGMA journal_size_limit = ' + workerData.sizeLimit);
  const frames = db.prepare('PRAGMA wal_checkpoint(NOOP)');
  const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
  const check = (force, id) => {
    clearTimeout(idle);
    let state = frames.get();
    const oversized = statSync(workerData.filename + '-wal').size > workerData.sizeLimit;
    if (force || oversized || state.log - state.checkpointed >= 1000) {
      checkpoint.get();
      state = frames.get();
    }
    parentPort.postMessage({ type: 'checked', id, ...state });
    // Let active low-volume writes share the WAL instead of flushing and restarting it every burst.
    if (state.log > state.checkpointed) {
      idle = setTimeout(() => check(true), 1000);
    }
  };
  parentPort.on('message', (request) => check(false, request.id));
} catch (error) {
  db?.close();
  throw error;
}
`
