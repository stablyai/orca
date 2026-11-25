import type Database from '../../../sqlite/sync-database'

/** The queued card a send carried, as the operation window reads it. */
export const SEND_QUEUED_CARD_SQL = `(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.queuedMessageId') END)`
/** A visible row a send can sit on (its prompt, the provider's copy, its turn): never a tool call
 *  or diff, which a long turn holds thousands of. */
export const SEND_PLACE_ROW_SQL = `hidden=0 AND (kind IS NULL OR kind NOT IN ('tool-call','diff'))`
/** The turn row a send was answered in, as the operation window reads it. */
export const SEND_ANSWERED_TURN_SQL = `(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.answeredInTurn.turnItemId') END)`

// No user_version change: older builds never name these indexes, and SQLite keeps them current on
// every write. They let a window through one turn find its sends without visiting every send.
const JOURNAL_SUBMISSION_WINDOW_INDEXES = `
CREATE INDEX IF NOT EXISTS journal_submission_queued_card
  ON journal_submission_attempts(session_id, epoch, ${SEND_QUEUED_CARD_SQL}) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_submission_answered_turn
  ON journal_submission_attempts(session_id, epoch, ${SEND_ANSWERED_TURN_SQL}) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_submission_provider_item
  ON journal_submission_attempts(session_id, epoch, provider_item_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_items_send_place
  ON journal_items(session_id, epoch, sequence, item_id) WHERE ${SEND_PLACE_ROW_SQL};`

export function ensureJournalSubmissionWindowIndexes(db: Database.Database): void {
  db.exec(JOURNAL_SUBMISSION_WINDOW_INDEXES)
}
