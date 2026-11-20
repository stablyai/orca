// Run as a node child so a slow disk never touches the main process; killing it only loses the copy.
// VACUUM INTO reads one snapshot and takes no write lock, so the runtime's writes never wait on it.
export const compactionChildSource = `
const { DatabaseSync } = require('node:sqlite');
const { closeSync, fsyncSync, openSync, writeFileSync } = require('node:fs');
const { filename, target } = JSON.parse(process.env.ORCA_ORCHESTRATION_COMPACTION);
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
`
