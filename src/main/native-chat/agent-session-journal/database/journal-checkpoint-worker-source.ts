// Evaluated source travels with both host bundles, without a separate worker entry or Electron imports.
// PASSIVE checkpoints never block the writer, so the worker needs no handshake with it.
export const journalCheckpointWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.filename);
let retry;
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
const behind = (state) => state.log - state.checkpointed >= workerData.frames;
const check = (force, id) => {
  clearTimeout(retry);
  const before = frames.get();
  let state = before;
  const ran = behind(state) || (force && state.log > state.checkpointed);
  if (ran) {
    passive.get();
    state = frames.get();
  }
  // Still behind: soon while catching up, slower while a reader pins the WAL, so committed frames
  // still reach disk once it lets go.
  if (behind(state)) {
    const moving = state.checkpointed > before.checkpointed;
    retry = setTimeout(() => check(false), moving ? workerData.retryMs : workerData.pinnedRetryMs);
  }
  // Only a request's own reply carries its id; a retry's reply answers no request.
  parentPort.postMessage({ type: 'checked', id, ran });
};
parentPort.on('message', (message) => {
  if (message.type === 'stop') {
    clearTimeout(retry);
    db.close();
    parentPort.close();
    return;
  }
  check(message.force === true, message.id);
});
check(false, 0);
`
