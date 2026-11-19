// Repeated verbatim in queries: SQLite uses a partial index only when the WHERE repeats its terms.

/** Approval and question rows, whatever their state. */
export const JOURNAL_PROMPT_ROWS = "kind IN ('approval','question')"

/** Newest-first seek for a chat's latest prompt, so finding it never walks earlier prompts. Added
 *  without a user_version change, like the async-question indexes, so older builds still open. */
export const JOURNAL_PROMPT_POSITION_INDEX = `CREATE INDEX IF NOT EXISTS journal_items_prompt_position
  ON journal_items(session_id,epoch,sequence,sequence_index,ordinal)
  WHERE hidden=0 AND ${JOURNAL_PROMPT_ROWS};`
