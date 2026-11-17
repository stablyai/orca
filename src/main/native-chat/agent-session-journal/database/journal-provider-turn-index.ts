// A query uses a partial index only when its WHERE repeats the index's terms verbatim, so this is a
// literal, not bound parameters.

/** Visible provider turn rows: Orca's own `/compact` command turns are not provider turns. */
export const JOURNAL_PROVIDER_TURN_ROWS = `hidden=0 AND kind='turn' AND NOT (turn_id>='compact:' AND turn_id<'compact;')`

/** Added without a user_version change, like the async-question indexes, so older builds still open
 *  the journal; it lets the newest provider turn be read without walking trailing command turns. */
export const JOURNAL_PROVIDER_TURN_INDEX = `CREATE INDEX IF NOT EXISTS journal_items_newest_provider_turn
  ON journal_items(session_id,epoch,ordinal) WHERE ${JOURNAL_PROVIDER_TURN_ROWS};`
