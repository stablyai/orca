import type SyncDatabase from '../sqlite/sync-database'

// Why the NUL prefix: tombstones share the file-path key space with real files, and
// `\0` cannot occur in one, so a synthetic key still gets the per-path cleanup mutex.
export function retireSearchSession(db: SyncDatabase, sessionId: number): void {
  db.prepare('INSERT OR IGNORE INTO search_pending_deletes(path,session_row_id) VALUES (?,?)').run(
    `\0session:${sessionId}`,
    sessionId
  )
}

export function discardSearchBatch(
  db: SyncDatabase,
  sessionId: number,
  batchId: number,
  ownsSession: boolean
): void {
  if (ownsSession) {
    retireSearchSession(db, sessionId)
  } else {
    db.prepare(
      'INSERT OR IGNORE INTO search_pending_deletes(path,session_row_id,batch_id) VALUES (?,?,?)'
    ).run(`\0batch:${batchId}`, sessionId, batchId)
  }
}

/** Only called on open, before this store can have active writers. */
export function recoverSearchWrites(db: SyncDatabase): void {
  // A staging session or a batch row that outlived its writer is by definition unfinished:
  // publish clears both in the same transaction that makes the rows visible.
  // The batch half skips a batch whose session is already retired: that tombstone
  // covers the same rows, and without the guard every reopen adds one more pass
  // over them.
  db.exec(`INSERT OR IGNORE INTO search_pending_deletes(path,session_row_id)
    SELECT char(0)||'session:'||id,id FROM sessions WHERE index_ready=0;
    INSERT OR IGNORE INTO search_pending_deletes(path,session_row_id,batch_id)
    SELECT char(0)||'batch:'||b.id,b.session_row_id,b.id FROM search_write_batches b
    WHERE NOT EXISTS (SELECT 1 FROM search_pending_deletes d
      WHERE d.session_row_id=b.session_row_id AND d.batch_id IS NULL)`)
}
