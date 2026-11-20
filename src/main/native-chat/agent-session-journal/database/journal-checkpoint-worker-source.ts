/** Slots of the shared liveness word: [0] is 1 while inside SQLite or starting, [1] counts replies. */
export const JOURNAL_CHECKPOINT_IN_CALL = 0
export const JOURNAL_CHECKPOINT_REPLIES = 1

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
// The owner tells a slow checkpoint from a dead worker by these, since a native call can't answer.
const liveness = new Int32Array(workerData.liveness);
const inCall = (run) => {
  Atomics.store(liveness, ${JOURNAL_CHECKPOINT_IN_CALL}, 1);
  try { return run(); } finally { Atomics.store(liveness, ${JOURNAL_CHECKPOINT_IN_CALL}, 0); }
};
const reply = (message) => {
  parentPort.postMessage(message);
  Atomics.add(liveness, ${JOURNAL_CHECKPOINT_REPLIES}, 1);
};
try {
  db = new DatabaseSync(workerData.filename);
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') {
    throw new Error('chat journal is not in WAL mode');
  }
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA checkpoint_fullfsync = ON;');
  db.exec('PRAGMA journal_size_limit = ' + workerData.sizeLimit);
  const noop = db.prepare('PRAGMA wal_checkpoint(NOOP)');
  const passive = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
  const truncateStatement = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)');
  const frames = { get: () => inCall(() => noop.get()) };
  const checkpoint = { get: () => inCall(() => passive.get()) };
  const truncate = { get: () => inCall(() => truncateStatement.get()) };
  Atomics.store(liveness, ${JOURNAL_CHECKPOINT_IN_CALL}, 0);
  const oversized = () => inCall(() => statSync(workerData.filename + '-wal').size > workerData.sizeLimit);
  const ceiling = (state) => state.log >= workerData.backpressureFrames;
  const schedule = (state, blocked) => {
    // While writes wait on the WAL, retry soon: a truncate needs a gap between readers' snapshots.
    if (blocked || state.log - state.checkpointed >= 1000) {
      idle = setTimeout(() => check(true), blocked ? 100 : 1000);
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
      reply({ type: 'truncate-request', ...pendingTruncate, ...state });
      return;
    }
    const blocked = (ceiling(state) || oversized()) && state.checkpointed < state.log;
    reply({ type: 'checked', id, generation, ...state, blocked });
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
      reply({ type: 'checked', id: pending.id, generation: pending.generation,
        truncateId: pending.truncateId, ...state, blocked });
      schedule(state, blocked);
      return;
    }
    if (pendingTruncate) {
      reply({ type: 'checked', id: request.id, generation: pendingTruncate.generation,
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
