// Evaluated source travels with both host bundles, without a separate worker entry or Electron imports.
export const journalCheckpointWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { statSync } = require('node:fs');
let db;
let idle;
let generation = 0;
let nextTruncate = 0;
let pendingTruncate;
try {
  db = new DatabaseSync(workerData.filename);
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') {
    throw new Error('chat journal is not in WAL mode');
  }
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA checkpoint_fullfsync = ON;');
  db.exec('PRAGMA journal_size_limit = ' + workerData.sizeLimit);
  const frames = db.prepare('PRAGMA wal_checkpoint(NOOP)');
  const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
  const truncate = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)');
  const oversized = () => statSync(workerData.filename + '-wal').size > workerData.sizeLimit;
  const ceiling = (state) => state.log >= workerData.backpressureFrames;
  const schedule = (state, blocked) => {
    if (blocked || state.log - state.checkpointed >= 1000) {
      idle = setTimeout(() => check(true), 1000);
    }
  };
  const check = (force, id, nextGeneration = generation) => {
    clearTimeout(idle);
    generation = Math.max(generation, nextGeneration);
    let state = frames.get();
    if (force || oversized() || state.log - state.checkpointed >= 1000) {
      checkpoint.get();
      state = frames.get();
    }
    if (state.log === state.checkpointed && (ceiling(state) || oversized())) {
      pendingTruncate = { truncateId: ++nextTruncate, id, generation, state };
      parentPort.postMessage({ type: 'truncate-request', ...pendingTruncate, ...state });
      return;
    }
    const blocked = (ceiling(state) || oversized()) && state.checkpointed < state.log;
    parentPort.postMessage({ type: 'checked', id, generation, ...state, blocked });
    schedule(state, blocked);
  };
  parentPort.on('message', (request) => {
    clearTimeout(idle);
    if (request.type === 'truncate') {
      if (!pendingTruncate || request.truncateId !== pendingTruncate.truncateId) return;
      const pending = pendingTruncate;
      let busy;
      const timeout = db.prepare('PRAGMA busy_timeout').get().timeout;
      db.exec('PRAGMA busy_timeout = 0;');
      try {
        busy = truncate.get().busy !== 0;
      } finally {
        db.exec('PRAGMA busy_timeout = ' + timeout);
      }
      const state = frames.get();
      const blocked = (ceiling(state) && (busy || state.checkpointed < state.log)) || oversized();
      pendingTruncate = undefined;
      parentPort.postMessage({ type: 'checked', id: pending.id, generation: pending.generation,
        truncateId: pending.truncateId, ...state, blocked });
      schedule(state, blocked);
      return;
    }
    if (pendingTruncate) {
      parentPort.postMessage({ type: 'checked', id: request.id, generation: pendingTruncate.generation,
        ...pendingTruncate.state, blocked: true });
      return;
    }
    check(request.force, request.id, request.generation);
  });
} catch (error) {
  db?.close();
  throw error;
}
`
