// A query uses an expression index only when it spells the indexed expression verbatim, so the
// operation window's reads use these constants.

// `payload`: the send's payload column, qualified where another table in scope has one too.

/** The turn row a send was answered in, as its payload names it. */
export function journalSendAnsweredTurn(payload = 'payload_json'): string {
  return `(CASE WHEN json_valid(${payload}) THEN json_extract(${payload},'$.answeredInTurn.turnItemId') END)`
}

/** The queued card a send carried, as its payload names it. */
export function journalSendQueuedCard(payload = 'payload_json'): string {
  return `(CASE WHEN json_valid(${payload}) THEN json_extract(${payload},'$.queuedMessageId') END)`
}

/** The keys that place a send by its rows, so a window finds its sends without reading every send
 *  in the chat. Added without a user_version change, so an older build still opens the journal and
 *  SQLite keeps them current for its writes too. The first build scans the table once, in the
 *  journal worker. */
export const JOURNAL_SUBMISSION_PLACEMENT_INDEXES = `CREATE INDEX IF NOT EXISTS journal_submission_provider_item
  ON journal_submission_attempts(session_id,epoch,provider_item_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_submission_answered_turn
  ON journal_submission_attempts(session_id,epoch,${journalSendAnsweredTurn()}) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_submission_queued_card
  ON journal_submission_attempts(session_id,epoch,${journalSendQueuedCard()}) WHERE current=1;`
