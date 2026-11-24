import { JOURNAL_SQL_ACCEPTED_INPUT_COLUMNS } from './journal-sql-accepted-inputs'
import type { JournalSqlScope } from './journal-sql-scope'

export function readJournalSqlStatusHead(scope: JournalSqlScope, work?: 'state' | 'input') {
  return scope.db
    .prepare(`SELECT context_boundary,last_sequence,last_activity_at,queue_latest_stop_json,
      (SELECT COALESCE(MAX(ordinal),-1)+1 FROM journal_submission_attempts
       WHERE session_id=? AND epoch=?) AS submission_count
      ${
        work
          ? `,(SELECT sequence FROM journal_items INDEXED BY journal_items_context_clear
        WHERE session_id=head.session_id AND epoch=head.epoch AND hidden=0 AND context_clear=1
        ORDER BY sequence DESC LIMIT 1) AS work_floor,
        (SELECT sequence FROM journal_items INDEXED BY journal_items_raw_context_clear
        WHERE session_id=head.session_id AND epoch=head.epoch AND context_clear=1
        ORDER BY sequence DESC LIMIT 1) AS raw_work_floor`
          : ''
      }
      ${
        work === 'input'
          ? `,(SELECT record_json FROM agent_session_records
        WHERE session_id=head.session_id) AS record_json,
        head.queue_manual_stop_json,head.queue_resumed_sequence,head.queue_reopened_sequence,
        head.queue_clear_sequence,head.queue_clear_operation_id,head.queue_clear_lifted,
        ${JOURNAL_SQL_ACCEPTED_INPUT_COLUMNS}`
          : ''
      }
      FROM journal_chat_state head WHERE session_id=? AND epoch=?`)
    .get(...scope.prefix, ...scope.prefix)
}
