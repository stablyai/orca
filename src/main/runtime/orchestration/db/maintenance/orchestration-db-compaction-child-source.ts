// Run as a node child, not a worker thread: only a process can be stopped in the middle of a VACUUM.
// Decides on SQLite's own counts (WAL included), under an exclusive lock, and prints one JSON line.
export const compactionChildSource = `
const { DatabaseSync } = require('node:sqlite');
const { statfsSync } = require('node:fs');
const { dirname } = require('node:path');
const w = JSON.parse(process.env.ORCA_ORCHESTRATION_COMPACTION);
const report = (result) => process.stdout.write(JSON.stringify(result) + '\\n');
const available = (dir) => {
  try {
    const disk = statfsSync(dir);
    return Number(disk.bavail) * Number(disk.bsize);
  } catch {
    return 0;
  }
};
const started = performance.now();
let db;
const compact = () => {
try {
  const pragma = (name) => Object.values(db.prepare('PRAGMA ' + name).get())[0];
  // Fails at once if any other connection, in any process, has the file open.
  db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
  // From here on only this process can have written the WAL, so the parent may clean it up after a stop.
  process.stdout.write('locked\\n');
  const pageSize = pragma('page_size');
  const pages = pragma('page_count');
  const freePages = pragma('freelist_count');
  const fileBytes = pages * pageSize;
  const liveBytes = (pages - freePages) * pageSize;
  const warranted =
    freePages * pageSize >= w.minFreeBytes && freePages >= pages * w.minFreeFraction;
  if (pragma('auto_vacuum') !== 0 || !warranted) {
    report({ kind: 'not-needed' });
  } else if (db.prepare(w.activeWorkSql).get().active) {
    // Rechecked under the lock: another process may have started work since the runtime looked.
    report({ kind: 'active' });
  } else if (liveBytes > w.maxLiveBytes) {
    report({ kind: 'too-large', liveBytes });
  } else {
    // VACUUM builds the copy in the temp directory, then writes it through the WAL beside the file.
    const neededBytes = 2 * fileBytes;
    const availableBytes = available(dirname(w.filename));
    if (availableBytes < neededBytes || available(w.tempDir) < liveBytes) {
      report({ kind: 'low-disk', neededBytes, availableBytes });
    } else {
      db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
      report({
        kind: 'compacted',
        beforeBytes: fileBytes,
        afterBytes: pragma('page_count') * pageSize,
        ms: Math.round(performance.now() - started)
      });
    }
  }
} catch (error) {
  const code = (error && error.errcode) & 0xff;
  report(code === 5 || code === 6 ? { kind: 'busy' } : { kind: 'failed', error: String(error) });
} finally {
  db?.close();
  process.stdin.destroy();
}
};
if (w.recoverOnly) {
  // After a stopped VACUUM: taking the file alone rolls its abandoned WAL frames back, and closing removes
  // them. Any other connection means it isn't ours to touch; that open does the rollback instead.
  try {
    db = new DatabaseSync(w.filename);
    db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
    report({ kind: 'recovered' });
  } catch (error) {
    report({ kind: 'busy' });
  } finally {
    db?.close();
  }
} else try {
  // Joined before the parent closes its connection, so that close is not the last one and never checkpoints.
  db = new DatabaseSync(w.filename);
  db.exec('PRAGMA busy_timeout = 0');
  db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
  process.stdout.write('ready\\n');
  process.stdin.once('data', compact);
} catch (error) {
  report({ kind: 'failed', error: String(error) });
  db?.close();
  process.stdin.destroy();
}
`
