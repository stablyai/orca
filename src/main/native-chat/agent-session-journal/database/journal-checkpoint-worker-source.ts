// Evaluated source travels with both host bundles, without a separate worker entry or Electron imports.
// PASSIVE checkpoints never block the writer, so the worker needs no handshake with it.
export const journalCheckpointWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.filename);
let idle;
let scheduled;
try {
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') {
    throw new Error('chat journal is not in WAL mode');
  }
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA checkpoint_fullfsync = ON;');
} catch (error) {
  db.close();
  throw error;
}
const frames = db.prepare('PRAGMA wal_checkpoint(NOOP)');
const passive = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
const check = (force) => {
  clearTimeout(idle);
  const before = frames.get();
  let state = before;
  if (state.log - state.checkpointed >= workerData.frames || (force && state.log > state.checkpointed)) {
    passive.get();
    state = frames.get();
  }
  // The WAL restarts only once every frame is checkpointed, so catch up while that makes progress;
  // a reader pinning the WAL stops progress, and the writer's next commit or recheck asks again.
  if (state.log > state.checkpointed && (!force || state.checkpointed > before.checkpointed)) {
    idle = setTimeout(() => check(true), workerData.idleMs);
  }
};
parentPort.on('message', (message) => {
  if (message.type === 'stop') {
    clearTimeout(idle);
    clearImmediate(scheduled?.immediate);
    db.close();
    parentPort.close();
    return;
  }
  // One check per turn, however many commits queued while the last one ran.
  if (scheduled) {
    scheduled.force ||= message.force;
    return;
  }
  scheduled = { force: message.force };
  scheduled.immediate = setImmediate(() => {
    const { force } = scheduled;
    scheduled = undefined;
    check(force);
  });
});
parentPort.postMessage({ type: 'ready' });
check(true);
`
