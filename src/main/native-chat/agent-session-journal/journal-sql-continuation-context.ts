import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  JournalContinuationChunkRead,
  JournalContinuationContext,
  JournalContinuedPayload
} from './journal-reads'
import { journalContextEpoch } from './context-epochs/journal-context-epoch'
import type { SqliteBindings, SqliteRow } from '../../sqlite/sqlite-statement'
import { readJournalStoredRow } from './journal-stored-output-rows'

const PAGE = 256
// Rows under this size carry their whole text; larger tool outputs and patches continue in chunks.
const CONTINUED_ROW_BYTES = 1024 * 1024
const CONTINUED_HEAD_CHARS = 16 * 1024
export const JOURNAL_CONTINUED_CHUNK_CHARS = 4 * 1024 * 1024
const CONTINUED_FIELDS = ['output', 'patch'] as const

/** Cut in SQLite, so neither the reader nor main holds a large head; marks which field continues. */
const EXPORT_PAYLOAD = `CASE WHEN octet_length(payload_json)<=${CONTINUED_ROW_BYTES} THEN payload_json
  ELSE (SELECT CASE ${CONTINUED_FIELDS.map(
    (field) => `WHEN json_type(p,'$.body.${field}.head')='text'
      AND length(json_extract(p,'$.body.${field}.head'))>${CONTINUED_HEAD_CHARS}
      THEN json_set(p,'$.body.${field}.head',
        substr(json_extract(p,'$.body.${field}.head'),1,${CONTINUED_HEAD_CHARS}),
        '$.body.${field}.continued',json('true'))`
  ).join(' ')} ELSE p END FROM (SELECT payload_json AS p)) END`

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
  const continued: JournalContinuedPayload[] = []
  let afterItem: SqliteBindings = []
  do {
    const rows = db
      .prepare(`SELECT ${EXPORT_PAYLOAD} AS payload_json, output_blob, sequence, sequence_index, ordinal
      FROM journal_items INDEXED BY journal_items_visible_position
      WHERE session_id=? AND epoch=? AND hidden=0 AND sequence>?
        ${afterItem.length ? 'AND (sequence, sequence_index, ordinal)>(?, ?, ?)' : ''}
      ORDER BY sequence, sequence_index, ordinal LIMIT ?`)
      .all(...prefix, clear, ...afterItem, PAGE)
    for (const row of rows) {
      const item = readJournalStoredRow(db, prefix, row)
      const field = takeContinuedField(item)
      if (field) {
        continued.push({ index: items.length, itemId: item.itemId, revision: item.revision, field })
      }
      items.push(item)
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
  return { cursor, items, submissions, continued }
}

function takeContinuedField(item: AgentJournalRenderItem): JournalContinuedPayload['field'] | null {
  const { body } = item
  const payload = body.kind === 'tool-call' ? body.output : body.kind === 'diff' ? body.patch : null
  if (!payload || !('continued' in payload)) {
    return null
  }
  delete payload.continued
  return body.kind === 'diff' ? 'patch' : 'output'
}

/** The next part of a continued head, or null once its item is gone or revised. */
export function readJournalDomainContinuationChunk(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  read: JournalContinuationChunkRead
): { kind: 'continuation-chunk'; text: string | null } {
  const row = db
    .prepare(`SELECT revision, substr(json_extract(payload_json,?),?,?) AS text
      FROM journal_items WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
    .get(
      `$.body.${read.field}.head`,
      read.offset,
      JOURNAL_CONTINUED_CHUNK_CHARS,
      target.sessionId,
      target.epoch,
      read.itemId
    )
  const current = row && Number(row.revision) === read.revision && typeof row.text === 'string'
  return { kind: 'continuation-chunk', text: current ? String(row.text) : null }
}

/** Where the continued text starts, in SQLite characters, since JavaScript counts UTF-16 units. */
export const JOURNAL_CONTINUED_FIRST_OFFSET = CONTINUED_HEAD_CHARS + 1

/** The keyset after a full page; empty once a short page proves nothing follows. */
function nextPage(rows: readonly SqliteRow[], columns: readonly string[]): SqliteBindings {
  const last = rows.at(-1)
  return last && rows.length === PAGE ? columns.map((column) => last[column]) : []
}
