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
// Rows under this size carry their whole text; a larger tool output or patch streams in byte chunks.
const CONTINUED_ROW_BYTES = 64 * 1024
const CONTINUED_TEXT_BYTES = 32 * 1024
// Byte slices pass NUL; a character cut at either edge only blurs the summary's excerpt.
const EXCERPT_BYTES = 8 * 1024
// One extraction per chunk re-reads the stored row, so chunks stay large but well under a reply.
export const JOURNAL_CONTINUED_CHUNK_BYTES = 32 * 1024 * 1024

/**
 * Built in SQLite, so neither the reader nor main holds a large text: a continued field keeps only
 * its start and end as an excerpt for the short hand-off summary, and is marked continued. The
 * subquery isn't flattened, so each text is extracted once.
 */
const EXPORT_PAYLOAD = `CASE WHEN octet_length(payload_json)<=${CONTINUED_ROW_BYTES} THEN payload_json
  ELSE (SELECT CASE ${(['output', 'patch'] as const)
    .map(
      (field) => `WHEN octet_length(${field})>${CONTINUED_TEXT_BYTES}
      THEN json_set(p,'$.body.${field}.head',
        CAST(substr(CAST(${field} AS BLOB),1,${EXCERPT_BYTES}) AS TEXT)||char(10)||'…'||char(10)||
          CAST(substr(CAST(${field} AS BLOB),-${EXCERPT_BYTES}) AS TEXT),
        '$.body.${field}.continued',json('true'))`
    )
    .join(' ')} ELSE p END
    FROM (SELECT payload_json AS p,
      json_extract(payload_json,'$.body.output.head') AS output,
      json_extract(payload_json,'$.body.patch.head') AS patch LIMIT 1)) END`

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

/** Stored UTF-8 bytes of a continued text from `offset` (1-based); null once it is gone or revised. */
export function readJournalDomainContinuationChunk(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  read: JournalContinuationChunkRead
): { kind: 'continuation-chunk'; bytes: Uint8Array | null } {
  // Blob slicing counts bytes and passes NUL, which text slicing stops at.
  const row = db
    .prepare(`SELECT revision, substr(CAST(json_extract(payload_json,?) AS BLOB),?,?) AS bytes
      FROM journal_items WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
    .get(
      `$.body.${read.field}.head`,
      read.offset,
      JOURNAL_CONTINUED_CHUNK_BYTES,
      target.sessionId,
      target.epoch,
      read.itemId
    )
  const bytes = row?.bytes
  return {
    kind: 'continuation-chunk',
    bytes:
      row && Number(row.revision) === read.revision && bytes instanceof Uint8Array ? bytes : null
  }
}

/** The keyset after a full page; empty once a short page proves nothing follows. */
function nextPage(rows: readonly SqliteRow[], columns: readonly string[]): SqliteBindings {
  const last = rows.at(-1)
  return last && rows.length === PAGE ? columns.map((column) => last[column]) : []
}
