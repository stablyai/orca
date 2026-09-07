// The standing demand for a rebuild that a repair leaves behind.
//
// A repair that empties the epoch republishes an `unreconcilable_prefix` anchor,
// and replay reads that back as history still owed. A repair that KEEPS a prefix
// has no such anchor to publish and — for a plain sequence gap — no malformed
// row to disclose either, so nothing on disk would record that the deleted
// suffix was never reconstructed. This marker is that record, written in the
// SAME transaction as the deletion: a crash between the two would otherwise
// leave the rows gone with nothing left asking for them back.
//
// It records the first sequence at which the epoch would hold content of its
// own again, because it retires under exactly the rule the emptied-epoch anchor
// takes: a fresh epoch carries the rebuild, and a session that writes past that
// sequence owns the epoch and stops the retry.

import type Database from '../../sqlite/sync-database'
import { deleteJournalRowSuffix } from './journal-row-table'

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

/** Drop the rejected suffix and record that it is owed, atomically. */
export function deleteJournalRepairedSuffix(input: {
  db: Database.Database
  sessionId: string
  epoch: string
  /** First sequence of the rejected suffix. */
  fromSeq: number
  /** First sequence left free once the suffix is gone. */
  contentFrom: number
  now: number
}): number {
  input.db.exec('BEGIN IMMEDIATE')
  try {
    const deleted = deleteJournalRowSuffix(input.db, input.sessionId, input.epoch, input.fromSeq)
    input.db.prepare(UPSERT_REPAIR).run(input.sessionId, input.epoch, input.contentFrom, input.now)
    input.db.exec('COMMIT')
    return deleted
  } catch (error) {
    input.db.exec('ROLLBACK')
    throw error
  }
}
