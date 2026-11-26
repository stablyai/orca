import { closeSync, openSync, writeSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  JournalContinuationSpill,
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
const SPILL_WRITE_BYTES = 8 * 1024 * 1024

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
        '$.body.${field}.continued',octet_length(${field}))`
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

/** Where the next export page starts: items in visible order, then the chat's sends. */
type JournalContinuationFrom = { part: 'items' | 'sends'; after: SqliteBindings }

type JournalContinuationPage = Omit<JournalContinuationContext, 'cursor'> & {
  next: JournalContinuationFrom | null
}

export type JournalContinuationRead =
  | { kind: 'continuation-context'; after?: AgentJournalCursor; through?: AgentJournalCursor }
  | { kind: 'continuation-spill'; spill: JournalContinuationSpill }

export type JournalContinuationReadResult =
  | { kind: 'continuation-context'; context: JournalContinuationContext }
  | { kind: 'continuation-spill'; bytes: number | null }

export async function readJournalDomainContinuation(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  operation: JournalContinuationRead,
  signal?: AbortSignal
): Promise<JournalContinuationReadResult> {
  const checkpoint = async () => {
    // Let cancellation reach readers hosted in another process.
    if (signal) {
      await setImmediate()
      signal.throwIfAborted()
    }
  }
  signal?.throwIfAborted()
  return operation.kind === 'continuation-context'
    ? {
        kind: 'continuation-context',
        context: await readJournalDomainContinuationContext(db, target, operation, checkpoint)
      }
    : spillJournalDomainContinuation(db, target, operation.spill, checkpoint)
}

/**
 * An explicit export, one reader snapshot answered in one reply, so the reply limit bounds the
 * whole context; a large tool output or patch counts only as its excerpt.
 */
async function readJournalDomainContinuationContext(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  { after, through }: Extract<JournalContinuationRead, { kind: 'continuation-context' }>,
  checkpoint: () => Promise<void>
): Promise<JournalContinuationContext> {
  const items: AgentJournalRenderItem[] = []
  const submissions: JournalContinuationContext['submissions'][number][] = []
  const continued: JournalContinuedPayload[] = []
  // One snapshot: the head and clear boundary hold for every page.
  const cursor = journalDomainContextHead(db, target)
  if (through && (through.epoch !== cursor.epoch || through.sequence > cursor.sequence)) {
    return { cursor, items, submissions, continued }
  }
  const ceiling = through?.sequence ?? cursor.sequence
  const clear = Number(
    db
      .prepare(`SELECT MAX(sequence) AS sequence FROM journal_items INDEXED BY journal_items_context_clear
      WHERE session_id=? AND epoch=? AND hidden=0 AND context_clear=1 AND sequence<=?`)
      .get(target.sessionId, target.epoch, ceiling)?.sequence ?? 0
  )
  const floor =
    after?.epoch === cursor.epoch && after.sequence <= ceiling
      ? Math.max(clear, after.sequence)
      : clear
  const read = (from?: JournalContinuationFrom) =>
    readJournalDomainContinuationPage(db, target, floor, through?.sequence, checkpoint, from)
  let page = await read()
  for (;;) {
    for (const part of page.continued) {
      continued.push({ ...part, index: part.index + items.length })
    }
    items.push(...page.items)
    submissions.push(...page.submissions)
    if (!page.next) {
      return { cursor, items, submissions, continued }
    }
    await checkpoint()
    page = await read(page.next)
  }
}

/** One query page of an export, in visible order and then the chat's sends. */
async function readJournalDomainContinuationPage(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  clear: number,
  through: number | undefined,
  checkpoint: () => Promise<void>,
  from: JournalContinuationFrom = { part: 'items', after: [] }
): Promise<JournalContinuationPage> {
  const prefix = [target.sessionId, target.epoch] as const
  const continued: JournalContinuedPayload[] = []
  const page = { items: [], submissions: [], continued, next: null }
  const { after } = from
  if (from.part === 'items') {
    const rows = db
      .prepare(`SELECT ${EXPORT_PAYLOAD} AS payload_json, output_blob, sequence, sequence_index, ordinal
      FROM journal_items AS item INDEXED BY journal_items_visible_position
      WHERE session_id=? AND epoch=? AND hidden=0 AND sequence>?
        ${
          through === undefined
            ? ''
            : `AND sequence<=? AND NOT EXISTS (
          SELECT 1 FROM journal_submission_attempts AS send INDEXED BY journal_submission_item
          WHERE send.session_id=item.session_id AND send.epoch=item.epoch
          AND send.item_id=item.item_id AND send.current=1
          AND (send.dispatch_state<>'accepted' OR send.accepted_sequence IS NULL OR send.accepted_sequence>?))`
        }
        ${after.length ? 'AND (sequence, sequence_index, ordinal)>(?, ?, ?)' : ''}
      ORDER BY sequence, sequence_index, ordinal LIMIT ?`)
      .all(...prefix, clear, ...(through === undefined ? [] : [through, through]), ...after, PAGE)
    const items: AgentJournalRenderItem[] = []
    for (const row of rows) {
      const item = readJournalStoredRow(db, prefix, row)
      const taken = takeContinuedField(item)
      if (taken) {
        continued.push({
          index: items.length,
          itemId: item.itemId,
          revision: item.revision,
          ...taken
        })
      }
      items.push(item)
    }
    const next = nextPage(rows, ['sequence', 'sequence_index', 'ordinal'])
    return { ...page, items, next: { part: next.length ? 'items' : 'sends', after: next } }
  }
  // Unaccepted sends belong only to an uncleared context, matching the saved-prompt policy.
  if (clear > 0 || through !== undefined) {
    const submissions: JournalContinuationPage['submissions'][number][] = []
    // Seek by acceptance, then sort only the suffix into the same order as a full export.
    for (const row of db
      .prepare(`SELECT payload_json FROM journal_submission_attempts
        INDEXED BY journal_submission_accepted_position
        WHERE session_id=? AND epoch=? AND current=1 AND accepted_sequence>?
        ${through === undefined ? '' : 'AND accepted_sequence<=?'}
        ORDER BY submitted_at, ordinal, message_id`)
      .iterate(...prefix, clear, ...(through === undefined ? [] : [through]))) {
      submissions.push(JSON.parse(String(row.payload_json)))
      if (submissions.length % PAGE === 0) {
        await checkpoint()
      }
    }
    return { ...page, submissions }
  }
  const rows = db
    .prepare(`SELECT payload_json, submitted_at, ordinal, message_id
    FROM journal_submission_attempts INDEXED BY journal_submission_order
    WHERE session_id=? AND epoch=? AND current=1
      ${after.length ? 'AND (submitted_at, ordinal, message_id)>(?, ?, ?)' : ''}
    ORDER BY submitted_at, ordinal, message_id LIMIT ?`)
    .all(...prefix, ...after, PAGE)
  const next = nextPage(rows, ['submitted_at', 'ordinal', 'message_id'])
  return {
    ...page,
    submissions: rows.map((row) => JSON.parse(String(row.payload_json))),
    next: next.length ? { part: 'sends', after: next } : null
  }
}

function takeContinuedField(
  item: AgentJournalRenderItem
): Pick<JournalContinuedPayload, 'field' | 'bytes'> | null {
  const { body } = item
  const payload = body.kind === 'tool-call' ? body.output : body.kind === 'diff' ? body.patch : null
  if (!payload || !('continued' in payload)) {
    return null
  }
  const bytes = Number(payload.continued)
  delete payload.continued
  return { field: body.kind === 'diff' ? 'patch' : 'output', bytes }
}

/**
 * Writes one continued text's stored UTF-8 bytes to a new private file, extracting it once; the
 * reply carries only the size, so the text never crosses to main. Null once it is gone or revised.
 */
async function spillJournalDomainContinuation(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  spill: JournalContinuationSpill,
  checkpoint: () => Promise<void>
): Promise<{ kind: 'continuation-spill'; bytes: number | null }> {
  // A blob passes NUL, which text functions stop at.
  const row = db
    .prepare(`SELECT CAST(json_extract(payload_json,?) AS BLOB) AS bytes
      FROM journal_items WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0 AND revision=?`)
    .get(`$.body.${spill.field}.head`, target.sessionId, target.epoch, spill.itemId, spill.revision)
  const bytes = row?.bytes
  if (!(bytes instanceof Uint8Array)) {
    return { kind: 'continuation-spill', bytes: null }
  }
  await checkpoint()
  const fd = openSync(spill.path, 'wx', 0o600)
  try {
    for (let offset = 0; offset < bytes.length;) {
      offset += writeSync(fd, bytes, offset, Math.min(SPILL_WRITE_BYTES, bytes.length - offset))
      await checkpoint()
    }
  } finally {
    closeSync(fd)
  }
  return { kind: 'continuation-spill', bytes: bytes.length }
}

/** The keyset after a full page; empty once a short page proves nothing follows. */
function nextPage(rows: readonly SqliteRow[], columns: readonly string[]): SqliteBindings {
  const last = rows.at(-1)
  return last && rows.length === PAGE ? columns.map((column) => last[column]) : []
}
