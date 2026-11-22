/** Shared progress word: odd while starting or handling work, and it moves on every step. */
export const JOURNAL_CHECKPOINT_PROGRESS = 0
/** Shared truncate slot: the owner grants or revokes a truncate; the worker runs it only if still granted. */
export const JOURNAL_CHECKPOINT_TRUNCATE = 1
export const JOURNAL_TRUNCATE_GRANTED = 1
export const JOURNAL_TRUNCATE_RUNNING = 2
export const JOURNAL_TRUNCATE_REVOKED = 3

/** Lets the worker run the truncate about to be sent. */
export function grantJournalTruncate(liveness: Int32Array): void {
  Atomics.store(liveness, JOURNAL_CHECKPOINT_TRUNCATE, JOURNAL_TRUNCATE_GRANTED)
}

/** Takes back a granted truncate the worker hasn't started; true when it is inside one now. */
export function revokeJournalTruncate(liveness: Int32Array): boolean {
  const was = Atomics.compareExchange(
    liveness,
    JOURNAL_CHECKPOINT_TRUNCATE,
    JOURNAL_TRUNCATE_GRANTED,
    JOURNAL_TRUNCATE_REVOKED
  )
  return was === JOURNAL_TRUNCATE_RUNNING
}

export function journalTruncateRunning(liveness: Int32Array): boolean {
  return Atomics.load(liveness, JOURNAL_CHECKPOINT_TRUNCATE) === JOURNAL_TRUNCATE_RUNNING
}

/** A reply from the checkpoint worker. */
export type CheckpointResponse = {
  type: 'checked' | 'truncate-request' | 'hello'
  id?: number
  generation: number
  truncateId?: number
  log: number
  checkpointed: number
  blocked: boolean
}

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
// The owner tells a slow checkpoint from a dead worker by this, since a native call can't answer.
// A unit of work ends after its reply is posted, so one load never sees a gap as idle and silent.
const progress = new Int32Array(workerData.liveness);
const work = (run) => {
  Atomics.add(progress, ${JOURNAL_CHECKPOINT_PROGRESS}, 1);
  try { run(); } finally { Atomics.add(progress, ${JOURNAL_CHECKPOINT_PROGRESS}, 1); }
};
const reply = (message) => parentPort.postMessage(message);
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
    // While writes wait on the WAL, retry soon: a truncate needs a gap between readers' snapshots.
    if (blocked || state.log - state.checkpointed >= 1000) {
      idle = setTimeout(() => work(() => check(true)), blocked ? 100 : 1000);
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
  parentPort.on('message', (request) => work(() => {
    // Ready to take checkpoints over; the owner hands them over only after this reply.
    if (request.type === 'hello') {
      reply({ type: 'hello' });
      return;
    }
    clearTimeout(idle);
    if (request.type === 'truncate') {
      if (!pendingTruncate || request.truncateId !== pendingTruncate.truncateId) return;
      const pending = pendingTruncate;
      // A revoked truncate never starts: the owner already gave the writer its lock back.
      let busy = true;
      if (Atomics.compareExchange(progress, ${JOURNAL_CHECKPOINT_TRUNCATE}, ${JOURNAL_TRUNCATE_GRANTED}, ${JOURNAL_TRUNCATE_RUNNING}) === ${JOURNAL_TRUNCATE_GRANTED}) {
        const timeout = db.prepare('PRAGMA busy_timeout').get().timeout;
        db.exec('PRAGMA busy_timeout = 0;');
        try {
          busy = truncate.get().busy !== 0;
        } finally {
          // SQLite's write lock is free again; the owner may hand writes back before this reply lands.
          Atomics.store(progress, ${JOURNAL_CHECKPOINT_TRUNCATE}, 0);
          db.exec('PRAGMA busy_timeout = ' + timeout);
        }
      }
      const state = frames.get();
      // Nothing that touches the filesystem runs between a truncate and its reply; one that didn't
      // succeed is reported blocked, and the worker's next retry measures the WAL again.
      const blocked = busy || (ceiling(state) && state.checkpointed < state.log);
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
  }));
  // Started: the owner counted startup as one unit of work.
  Atomics.add(progress, ${JOURNAL_CHECKPOINT_PROGRESS}, 1);
} catch (error) {
  db?.close();
  throw error;
}
`
