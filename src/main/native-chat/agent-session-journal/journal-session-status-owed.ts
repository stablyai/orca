// The chats the background copy owes a status row: in the host's database with none, and not
// given up on (journal-background-failures.ts). The row itself is written by
// journal-session-status-backfill.ts.

import type Database from '../../sqlite/sync-database'
import { readJournalSessionEpoch, readJournalTip } from './journal-row-table'

// The give-up's input is built here as `journalStatusInput` builds it.
const SELECT_WITHOUT_STATUS = `SELECT s.session_id AS session_id FROM journal_sessions s
WHERE NOT EXISTS (SELECT 1 FROM journal_session_state st WHERE st.session_id = s.session_id)
AND NOT EXISTS (SELECT 1 FROM journal_background_failures f
  WHERE f.session_id = s.session_id AND f.step = 'status' AND f.app_version = ?
  AND f.input = s.epoch || ':' || (SELECT ifnull(max(r.seq), 0) FROM journal_rows r
    WHERE r.session_id = s.session_id AND r.epoch = s.epoch))`

/** Every chat in the host's database with no status row, but one whose row failed for good on
 *  the rows it holds now, under this app version (journal-background-failures.ts). */
export function readJournalSessionIdsWithoutStatus(
  db: Database.Database,
  appVersion: string
): string[] {
  return db
    .prepare(SELECT_WITHOUT_STATUS)
    .all(appVersion)
    .flatMap((row) => (typeof row.session_id === 'string' ? [row.session_id] : []))
}

/** What a give-up of the chat's status row is keyed to: its epoch and tip. */
export function journalStatusInput(db: Database.Database, sessionId: string): string | null {
  const epoch = readJournalSessionEpoch(db, sessionId)
  return epoch === null ? null : `${epoch}:${readJournalTip(db, sessionId, epoch)}`
}
