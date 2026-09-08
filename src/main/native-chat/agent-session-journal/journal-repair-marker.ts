// The live generation still owes reconstruction until it writes content of its own.
// Recovery evidence has a separate, immutable lifetime in journal_recovery_epochs.

import type Database from '../../sqlite/sync-database'

const SELECT_REPAIR = 'SELECT epoch, content_from FROM journal_repairs WHERE session_id = ?'
const UPSERT_REPAIR = `INSERT INTO journal_repairs (session_id, epoch, content_from, repaired_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  epoch = excluded.epoch, content_from = excluded.content_from, repaired_at = excluded.repaired_at`
const DELETE_REPAIR = 'DELETE FROM journal_repairs WHERE session_id = ?'

/**
 * The sequence a pending repair on THIS epoch left free, or null when none is
 * pending. Epoch-scoped: a marker raised on an epoch that has since been
 * superseded says nothing about the live one.
 */
export function pendingJournalRepairSequence(
  db: Database.Database,
  sessionId: string,
  epoch: string
): number | null {
  const row = db.prepare(SELECT_REPAIR).get(sessionId) as
    | { epoch?: string; content_from?: number }
    | undefined
  return row?.epoch === epoch ? (row.content_from ?? null) : null
}

/** Retires the marker. Called from inside the epoch transactions, whose new
 *  epoch is the rebuilt history the marker was holding out for. */
export function clearJournalRepairMarker(db: Database.Database, sessionId: string): void {
  db.prepare(DELETE_REPAIR).run(sessionId)
}

/** Record the rebuild demand inside the caller's repair-generation transaction. */
export function writeJournalRepairMarker(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  contentFrom: number,
  now: number
): void {
  db.prepare(UPSERT_REPAIR).run(sessionId, epoch, contentFrom, now)
}
