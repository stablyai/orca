import type Database from '../../sqlite/sync-database'

export const JOURNAL_EVENT_HISTORY_MS = 24 * 60 * 60 * 1000

export type JournalSqlEventTailResult = {
  kind: 'event-tail'
  deleted: number
  nextDueAt: number | null
}

/** Runs inside the writer transaction; replay metadata owns no bodies or receipt obligations. */
export function pruneJournalSqlEventTail(
  db: Database.Database,
  now: number
): JournalSqlEventTailResult {
  const expired = db
    .prepare(`SELECT session_id,epoch,sequence FROM journal_events
      WHERE saved_at<=? ORDER BY saved_at,session_id,epoch,sequence LIMIT 50`)
    .all(now - JOURNAL_EVENT_HISTORY_MS)
  const compact = db.prepare(`UPDATE journal_chat_state
    SET retained_sequence=MAX(retained_sequence,?) WHERE session_id=? AND epoch=?`)
  const remove = db.prepare(
    'DELETE FROM journal_events WHERE session_id=? AND epoch=? AND sequence=?'
  )
  for (const row of expired) {
    // Advance through any deleted hole even if the wall clock made saved_at nonmonotonic.
    compact.run(row.sequence, row.session_id, row.epoch)
    remove.run(row.session_id, row.epoch, row.sequence)
  }
  const oldest = db
    .prepare(
      'SELECT saved_at FROM journal_events ORDER BY saved_at,session_id,epoch,sequence LIMIT 1'
    )
    .get()
  return {
    kind: 'event-tail',
    deleted: expired.length,
    nextDueAt: oldest ? Number(oldest.saved_at) + JOURNAL_EVENT_HISTORY_MS : null
  }
}
