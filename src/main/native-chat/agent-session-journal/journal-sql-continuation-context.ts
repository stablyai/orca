import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalContinuationContext } from './journal-reads'
import { journalContextEpoch } from './context-epochs/journal-context-cursor'
import { JournalSqlHistoryValues } from './journal-sql-history-values'
import { JournalSqlScalars } from './journal-sql-scalars'
import type { JournalSqlScope } from './journal-sql-scope'
import type { SqliteBindings, SqliteRow } from '../../sqlite/sqlite-statement'

const PAGE = 256

/** An explicit export: query chunks are bounded, the answer is the whole effective context. */
export function readJournalSqlContinuationContext(
  scope: JournalSqlScope
): JournalContinuationContext {
  const scalars = new JournalSqlScalars(scope, 'reducer')
  const history = new JournalSqlHistoryValues(scope.db, scope, { bodies: 0 })
  const clear = Number(
    scope.db
      .prepare(`SELECT MAX(sequence) AS sequence FROM journal_proj_items
      WHERE session_id=? AND epoch=? AND context_clear=1 AND hidden=0`)
      .get(...scope.prefix)?.sequence ?? 0
  )
  const items: AgentJournalRenderItem[] = []
  let afterItem: SqliteBindings = []
  do {
    const rows = scope.db
      .prepare(`SELECT entry_key, incarnation, sequence, sequence_index, ordinal FROM journal_proj_items
      WHERE session_id=? AND epoch=? AND hidden=0 AND sequence>?
        ${afterItem.length ? 'AND (sequence, sequence_index, ordinal)>(?, ?, ?)' : ''}
      ORDER BY sequence, sequence_index, ordinal LIMIT ?`)
      .all(...scope.prefix, clear, ...afterItem, PAGE)
    for (const row of rows) {
      items.push(history.item(scope.examined(row)))
    }
    afterItem = nextPage(rows, ['sequence', 'sequence_index', 'ordinal'])
  } while (afterItem.length)
  // Unaccepted sends belong only to an uncleared context, matching the saved-prompt policy.
  let afterSend: SqliteBindings = []
  do {
    const rows = scope.db
      .prepare(`SELECT item_key, submitted_at, input_ordinal, client_message_id FROM journal_proj_submissions
      WHERE session_id=? AND epoch=? AND current=1 AND item_key IS NOT NULL
        ${clear > 0 ? 'AND accepted_seq>?' : ''}
        ${afterSend.length ? 'AND (submitted_at, input_ordinal, client_message_id)>(?, ?, ?)' : ''}
      ORDER BY submitted_at, input_ordinal, client_message_id LIMIT ?`)
      .all(...scope.prefix, ...(clear > 0 ? [clear] : []), ...afterSend, PAGE)
    history.loadSubmissions(rows.map((row) => String(scope.examined(row).item_key)))
    afterSend = nextPage(rows, ['submitted_at', 'input_ordinal', 'client_message_id'])
  } while (afterSend.length)
  return {
    cursor: {
      epoch: journalContextEpoch(scope.epoch, scalars.get('contextBoundary', 1)),
      sequence: scalars.get('lastSequence', 0)
    },
    items,
    submissions: [...history.submissions.values()]
  }
}

/** The keyset after a full page; empty once a short page proves nothing follows. */
function nextPage(rows: readonly SqliteRow[], columns: readonly string[]): SqliteBindings {
  const last = rows.at(-1)
  return last && rows.length === PAGE ? columns.map((column) => last[column]) : []
}
