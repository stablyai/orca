// The copy, on a thread of its own: VACUUM INTO reads one snapshot and takes no write lock, so the
// runtime's writes never wait on it. Without a target it only truncates the WAL first: a passive checkpoint
// leaves its size, which quit would otherwise read as work still pending.
const copySource = `
const { DatabaseSync } = require('node:sqlite');
const { closeSync, fsyncSync, openSync, writeFileSync } = require('node:fs');
const { filename, target } = require('node:worker_threads').workerData;
if (!target) {
  const db = new DatabaseSync(filename);
  try {
    // As the checkpoint thread: 3.51.0-3.51.2 can corrupt a WAL reset that overlaps another checkpoint.
    const [major, minor, patch] = db.prepare('SELECT sqlite_version() AS v').get().v.split('.').map(Number);
    if (major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3)))) {
      // Drained without the writer lock first, so the truncation holds it only for a moment, and never waits.
      db.exec('PRAGMA busy_timeout = 0; PRAGMA wal_checkpoint(PASSIVE); PRAGMA wal_checkpoint(TRUNCATE)');
    }
  } finally {
    db.close();
  }
} else {
  // Created private first: VACUUM INTO keeps the empty file's mode, and the copy holds the same data.
  writeFileSync(target, '', { flag: 'wx', mode: 0o600 });
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 1000; PRAGMA auto_vacuum = INCREMENTAL');
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
  // On disk before quit renames it over the original.
  const fd = openSync(target, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
`

// Run as a node child so a slow disk never touches the main process; killing it only loses the copy. Its
// main thread stays free to stop it at the budget, or once the app is gone, killed or not.
export const compactionChildSource = `
const { Worker } = require('node:worker_threads');
const { filename, target, budgetMs } = JSON.parse(process.env.ORCA_ORCHESTRATION_COMPACTION);
const stop = () => process.kill(process.pid, 'SIGKILL');
setTimeout(stop, budgetMs);
// The app never writes stdin; its end closes when the app exits.
process.stdin.on('end', stop).on('error', stop).resume();
const copy = new Worker(${JSON.stringify(copySource)}, { eval: true, workerData: { filename, target } });
copy.on('error', () => process.exit(1));
copy.on('exit', (code) => process.exit(code));
`
