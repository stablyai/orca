import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalContinuationContext } from './journal-reads'
import { journalContextEpoch } from './context-epochs/journal-context-epoch'
import type { SqliteBindings, SqliteRow } from '../../sqlite/sqlite-statement'

const PAGE = 256

/** The logical cursor of the ready head that owns this epoch; an unready or retired head has none. */
export function journalDomainContextHead(
  db: Database.Database,
  target: { sessionId: string; epoch: string }
): AgentJournalCursor {
  const head = db
    .prepare(`SELECT epoch, last_sequence, context_boundary FROM journal_chat_state
    WHERE session_id=?`)
    .get(target.sessionId)
  if (head?.epoch === null || head?.epoch === undefined || String(head.epoch) !== target.epoch) {
    throw new Error('journal item read targets a chat epoch that is not current')
  }
  return {
    epoch: journalContextEpoch(target.epoch, Number(head.context_boundary)),
    sequence: Number(head.last_sequence)
  }
}

/** An explicit export: query chunks are bounded, the answer is the whole effective context. */
export function readJournalDomainContinuationContext(
  db: Database.Database,
  target: { sessionId: string; epoch: string }
): JournalContinuationContext {
  const prefix = [target.sessionId, target.epoch] as const
  const cursor = journalDomainContextHead(db, target)
  const clear = Number(
    db
      .prepare(`SELECT MAX(sequence) AS sequence FROM journal_items INDEXED BY journal_items_context_clear
      WHERE session_id=? AND epoch=? AND hidden=0 AND context_clear=1`)
      .get(...prefix)?.sequence ?? 0
  )
  const items: AgentJournalRenderItem[] = []
  let afterItem: SqliteBindings = []
  do {
    const rows = db
      .prepare(`SELECT payload_json, sequence, sequence_index, ordinal
      FROM journal_items INDEXED BY journal_items_visible_position
      WHERE session_id=? AND epoch=? AND hidden=0 AND sequence>?
        ${afterItem.length ? 'AND (sequence, sequence_index, ordinal)>(?, ?, ?)' : ''}
      ORDER BY sequence, sequence_index, ordinal LIMIT ?`)
      .all(...prefix, clear, ...afterItem, PAGE)
    for (const row of rows) {
      items.push(JSON.parse(String(row.payload_json)))
    }
    afterItem = nextPage(rows, ['sequence', 'sequence_index', 'ordinal'])
  } while (afterItem.length)
  // Unaccepted sends belong only to an uncleared context, matching the saved-prompt policy.
  const submissions: AgentJournalSubmission[] = []
  let afterSend: SqliteBindings = []
  do {
    const rows = db
      .prepare(`SELECT payload_json, submitted_at, ordinal, message_id
      FROM journal_submission_attempts INDEXED BY journal_submission_order
      WHERE session_id=? AND epoch=? AND current=1
        ${clear > 0 ? 'AND accepted_sequence>?' : ''}
        ${afterSend.length ? 'AND (submitted_at, ordinal, message_id)>(?, ?, ?)' : ''}
      ORDER BY submitted_at, ordinal, message_id LIMIT ?`)
      .all(...prefix, ...(clear > 0 ? [clear] : []), ...afterSend, PAGE)
    for (const row of rows) {
      submissions.push(JSON.parse(String(row.payload_json)))
    }
    afterSend = nextPage(rows, ['submitted_at', 'ordinal', 'message_id'])
  } while (afterSend.length)
  return { cursor, items, submissions }
}

/** The keyset after a full page; empty once a short page proves nothing follows. */
function nextPage(rows: readonly SqliteRow[], columns: readonly string[]): SqliteBindings {
  const last = rows.at(-1)
  return last && rows.length === PAGE ? columns.map((column) => last[column]) : []
}
