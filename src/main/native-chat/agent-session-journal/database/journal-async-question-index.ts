import { CODEX_ASYNC_QUESTION_TOOL } from '../../../../shared/native-chat/input/questions/codex-async-question-input'

// A query uses a partial index only when its WHERE repeats the index's terms verbatim, so these are
// literals, not bound parameters.

/** Root assistant rows naming Codex's async question tool. */
export const JOURNAL_ASYNC_QUESTION_ROWS = `root=1 AND message_role='assistant' AND command_entry=0 AND instr(payload_json,'${CODEX_ASYNC_QUESTION_TOOL}')>0`

/** The person's own messages: another agent's carry `from`. Guarded so a malformed row never fails
 *  a write or a read. */
export const JOURNAL_PERSON_PROMPT_ROWS = `prompt=1 AND (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.body.from') END) IS NULL`

/** Added without a user_version change, so an older build still opens the journal and SQLite keeps
 *  them current for its writes too. The first build scans the table once, in the journal worker. */
export const JOURNAL_ASYNC_QUESTION_INDEXES = `CREATE INDEX IF NOT EXISTS journal_items_async_question
  ON journal_items(session_id,epoch,sequence,sequence_index,ordinal)
  WHERE hidden=0 AND ${JOURNAL_ASYNC_QUESTION_ROWS};
CREATE INDEX IF NOT EXISTS journal_items_person_prompt
  ON journal_items(session_id,epoch,sequence,sequence_index,ordinal)
  WHERE hidden=0 AND ${JOURNAL_PERSON_PROMPT_ROWS};`
