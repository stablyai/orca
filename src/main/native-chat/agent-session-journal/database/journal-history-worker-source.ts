// Only locators cross the thread boundary; consumers strictly decode the original records.
export const journalHistoryWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.filename, { readOnly: true });
db.exec('PRAGMA busy_timeout = 1000');
parentPort.on('message', (request) => {
  try {
    const raw = request.generation === 0;
    const statement = raw
      ? db.prepare('SELECT seq, row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT 128')
      : db.prepare("SELECT seq, field, entry_key FROM journal_outcomes WHERE generation = ? AND (seq, field, entry_key) > (?, ?, ?) AND seq <= ? ORDER BY seq, field, entry_key LIMIT 128");
    const parameters = raw
      ? [request.sessionId, request.epoch, request.after.seq, request.through]
      : [request.generation, request.after.seq, request.after.field, request.after.key, request.through];
    const payload = raw ? null : db.prepare('SELECT value_json, deleted FROM journal_outcomes WHERE generation = ? AND seq = ? AND field = ? AND entry_key = ?');
    const locators = [];
    let after = request.after;
    let count = 0;
    let bytes = 0;
    for (const row of statement.iterate(...parameters)) {
      count++;
      after = { seq: row.seq, field: row.field || '', key: row.entry_key || '' };
      bytes += Buffer.byteLength(row.field || '') + Buffer.byteLength(row.entry_key || '');
      const stored = raw ? row : row.field === 'items'
        ? payload.get(request.generation, row.seq, row.field, row.entry_key) : null;
      const json = raw ? row.row_json : stored?.value_json;
      if (json != null) bytes += Buffer.byteLength(json);
      let kind = 0;
      if (raw || row.field === 'items') {
        try {
          const value = JSON.parse(json);
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            kind = raw ? 3 : 4;
          } else if (raw) {
            if (typeof value.kind !== 'string') kind |= 3;
            if (value.kind === 'epoch') kind |= 2;
            if (Object.hasOwn(value, 'stopEvent')) kind |= 1;
          } else if (!value.body || typeof value.body !== 'object' || Array.isArray(value.body) ||
            !['agent-start', 'agent-handoff', 'message', 'tool-call', 'diff', 'approval', 'question', 'status', 'turn'].includes(value.body.kind)) {
            kind = 4;
          } else if (stored.deleted !== 1 &&
            (value.body?.kind === 'question' || value.body?.kind === 'approval') &&
            value.body?.resolution?.state !== 'pending' &&
            value.body?.resolution?.state !== 'cancelled') {
            kind = 4;
          }
        } catch {
          kind = raw ? 3 : 4;
        }
      }
      if (kind) locators.push({ ...after, kind });
      // A single legitimate large record is admitted; later rows belong to the next page.
      if (bytes >= 1024 * 1024) break;
    }
    parentPort.postMessage({ id: request.id, locators, after,
      complete: count < 128 && bytes < 1024 * 1024 });
  } catch {
    parentPort.postMessage({ id: request.id, failed: true });
  }
});
`
