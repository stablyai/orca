// Evaluated in a worker thread so the rewrites and their I/O stalls stay off the main thread.
export const workerOutputCopyRemovalWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.filename);
const finish = (removed) => {
  db.close();
  parentPort.postMessage({ type: 'finished', removed });
  parentPort.close();
};
try {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_size_limit = ' + workerData.journalSizeLimit);
  // octet_length() reads only the record header, so neither the index nor the pick reads saved output.
  db.exec('CREATE INDEX IF NOT EXISTS ' + workerData.index + ' ON worker_terminal_archives(dispatch_id) WHERE ' + workerData.copyPredicate);
  const pick = db.prepare('SELECT dispatch_id FROM worker_terminal_archives INDEXED BY ' + workerData.index + ' WHERE ' + workerData.copyPredicate + ' LIMIT 1');
  // Keep only the fields a reader uses to find the original; json_patch drops the absent ones.
  const shrink = db.prepare(
    "UPDATE worker_terminal_archives SET content = CASE WHEN json_valid(content) THEN json_patch('{\\"version\\":3}', json_object(" +
      "'agent', json_extract(content, '$.agent'), " +
      "'processIncarnation', json_extract(content, '$.processIncarnation'), " +
      "'sessionId', json_extract(content, '$.sessionId'), " +
      "'transcriptPath', json_extract(content, '$.transcriptPath'), " +
      "'wslDistro', json_extract(content, '$.wslDistro'), " +
      "'fallbackReason', json_extract(content, '$.fallbackReason'))) " +
      "ELSE '{\\"version\\":3}' END WHERE dispatch_id = ? AND " + workerData.copyPredicate
  );
  const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
  let removed = 0;
  // One row per write transaction keeps each hold on the write lock to about a millisecond.
  const removeOne = () => {
    const row = pick.get();
    if (!row) return false;
    removed += Number(shrink.run(row.dispatch_id).changes);
    // Checkpoint here so the main connection's commits never inherit these WAL frames.
    checkpoint.get();
    return true;
  };
  const step = () => {
    let more;
    try {
      more = removeOne();
    } catch (error) {
      db.close();
      throw error;
    }
    if (!more) return finish(removed);
    parentPort.postMessage({ type: 'progress', removed });
    setTimeout(step, workerData.gapMs);
  };
  step();
} catch (error) {
  db.close();
  throw error;
}
`
