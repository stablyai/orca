import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import { readStoredQueuedMessageRow } from './queued-messages/queued-message-stored-row'
import { isUnsettledQueuedMessage } from './queued-messages/queued-message-table'
import type { LegacyOriginal } from './journal-legacy-content-proof'
import type Database from '../../sqlite/sync-database'

// The original's own version of one chat, and whether this store holds its waiting text, read in
// bounded steps: every queue is measured in SQL before any of its rows reaches JS.

/** Every message still waiting to send in the original is held here by id with the same text. */
export function queueHeld(
  source: Database.Database,
  store: Database.Database,
  sessionId: string
): boolean {
  // Each card by its key: one seek per epoch the chat's cards have, then one per (epoch, message),
  // so the cost follows the waiting messages, not the chat's whole queue history.
  const firstEpoch = store.prepare(
    'SELECT epoch FROM journal_queue_cards WHERE session_id=? ORDER BY epoch LIMIT 1'
  )
  const nextEpoch = store.prepare(
    'SELECT epoch FROM journal_queue_cards WHERE session_id=? AND epoch>? ORDER BY epoch LIMIT 1'
  )
  const epochs: string[] = []
  for (
    let row = firstEpoch.get(sessionId);
    row;
    row = nextEpoch.get(sessionId, String(row.epoch))
  ) {
    epochs.push(String(row.epoch))
  }
  const card = store.prepare(`SELECT payload_json FROM journal_queue_cards
    WHERE session_id=? AND epoch=? AND message_id=?`)
  // Settled rows are never read: only waiting text can differ (the content scan refuses rows it
  // can't read).
  // Unordered, so the first waiting row is read without SQLite sorting the whole queue first.
  let rows = 0
  for (const row of source.prepare(UNSETTLED_QUEUE_ANY_ORDER_SQL).iterate(sessionId)) {
    // Measured before; bounded again in case an older Orca queued more since.
    if (++rows > LEGACY_QUEUE_MAX_ROWS) {
      throw oversizedQueue()
    }
    const queued = readStoredQueuedMessageRow(row)
    if (!queued || !isUnsettledQueuedMessage(queued)) {
      return false
    }
    // The same text, waiting here or already acted on here; anything else is kept from the original.
    if (
      !epochs.some((epoch) => {
        const held = card.get(sessionId, epoch, queued.messageId)
        return held !== undefined && sameQueued(held.payload_json, queued)
      })
    ) {
      return false
    }
  }
  return true
}

/** The same text and send options as the original's waiting message. */
function sameQueued(payload: unknown, queued: { body: unknown; options?: unknown }): boolean {
  try {
    const card: unknown = typeof payload === 'string' ? JSON.parse(payload) : null
    return (
      typeof card === 'object' &&
      card !== null &&
      'body' in card &&
      JSON.stringify(card.body) === JSON.stringify(queued.body) &&
      JSON.stringify('options' in card ? card.options : undefined) ===
        JSON.stringify(queued.options)
    )
  } catch {
    return false
  }
}

const PERSON_EDITS_SQL = `CASE WHEN json_valid(record_json) THEN json_array(
  CASE WHEN json_extract(record_json,'$.conversationNameSource')='user'
    THEN json_extract(record_json,'$.conversationName') END,
  json_extract(record_json,'$.options'),
  json_extract(record_json,'$.permissionMode')) END`

/** A name the person set, options or permission mode that differ here from the original. */
export function personEditsDiffer(
  source: Database.Database,
  store: Database.Database,
  sessionId: string
): boolean {
  const read = (db: Database.Database) =>
    db
      .prepare(`SELECT ${PERSON_EDITS_SQL} AS edits FROM agent_session_records WHERE session_id=?`)
      .get(sessionId)?.edits
  const original = hasTable(source, 'agent_session_records') ? read(source) : undefined
  return original !== undefined && original !== null && read(store) !== original
}

/** The original's record, and the text it still has waiting to send when that differs, verbatim. */
export function originalVersion(
  source: Database.Database,
  sessionId: string,
  withQueue: boolean
): LegacyOriginal {
  const record = source
    .prepare(
      'SELECT length(CAST(record_json AS BLOB)) AS bytes FROM agent_session_records WHERE session_id=?'
    )
    .get(sessionId)
  const recordBytes = Number(record?.bytes ?? 0)
  const queue = withQueue && hasTable(source, 'queued_messages')
  // Measured before anything is read, and bounded again while reading: an older Orca may write
  // between the two.
  assertLegacyQueueBounded(source, sessionId, recordBytes, queue)
  const row = source
    .prepare(
      `SELECT record_json, ${PERSON_EDITS_SQL} AS edits FROM agent_session_records WHERE session_id=?`
    )
    .get(sessionId)
  const queued: Record<string, unknown>[] = []
  let bytes = recordBytes
  if (queue) {
    for (const message of source.prepare(UNSETTLED_QUEUE_SQL).iterate(sessionId)) {
      bytes += queuedRowBytes(message)
      if (queued.length >= LEGACY_QUEUE_MAX_ROWS || bytes > LEGACY_QUEUE_MAX_BYTES) {
        throw oversizedQueue()
      }
      queued.push(message)
    }
  }
  return {
    value: JSON.stringify({ version: 1, record: row?.record_json ?? null, queued }),
    identity: JSON.stringify([
      // A record that isn't valid JSON has no fields to read; its bytes are what a person has.
      row?.edits ?? row?.record_json ?? null,
      queued.map((message) => [message.message_id, message.body_json, message.options_json])
    ])
  }
}

/**
 * A kept original stays small: at most this many waiting messages, and this many raw bytes of
 * record and queued rows (about 10 MiB once serialized), so one page of originals fits a reply.
 */
const LEGACY_QUEUE_MAX_ROWS = 2048
const LEGACY_QUEUE_MAX_BYTES = 2 * 1024 * 1024
const UNSETTLED_QUEUE_ANY_ORDER_SQL = `SELECT * FROM queued_messages
  WHERE session_id=? AND state IN ('waiting','returned')`
const UNSETTLED_QUEUE_SQL = `SELECT * FROM queued_messages
  WHERE session_id=? AND state IN ('waiting','returned') ORDER BY position, message_id`
const QUEUED_TEXT_COLUMNS = [
  'message_id',
  'body_json',
  'fingerprint',
  'host_instance',
  'state',
  'hold_reason',
  'returned_reason',
  'returned_rejection',
  'settled_by_op',
  'consumed_as',
  'carried_from',
  'queued_epoch',
  'options_json',
  // No build reads it, but a kept original holds it verbatim (journal-legacy-source-proof.ts).
  'source_json'
] as const

/**
 * The chat's waiting text, measured in SQL with no row read into JS, and over at most one row past
 * the limit however long the queue is.
 */
export function assertLegacyQueueBounded(
  source: Database.Database,
  sessionId: string,
  recordBytes = 0,
  queue = true
): void {
  if (recordBytes > LEGACY_QUEUE_MAX_BYTES) {
    throw oversizedQueue()
  }
  if (!queue || !hasTable(source, 'queued_messages')) {
    return
  }
  const measured = source
    .prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(${queuedTextColumns(source)
        .map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`)
        .join('+')}),0) AS bytes FROM (SELECT * FROM queued_messages
        WHERE session_id=? AND state IN ('waiting','returned') LIMIT ?)`
    )
    .get(sessionId, LEGACY_QUEUE_MAX_ROWS + 1)
  if (
    Number(measured?.rows ?? 0) > LEGACY_QUEUE_MAX_ROWS ||
    recordBytes + Number(measured?.bytes ?? 0) > LEGACY_QUEUE_MAX_BYTES
  ) {
    throw oversizedQueue()
  }
}

/** Journals from before some columns were added lack them; a missing column holds nothing. */
function queuedTextColumns(source: Database.Database): string[] {
  const present = new Set(
    source
      .prepare('PRAGMA table_info(queued_messages)')
      .all()
      .map((column) => String(column.name))
  )
  return QUEUED_TEXT_COLUMNS.filter((column) => present.has(column))
}

function queuedRowBytes(row: Record<string, unknown>): number {
  let bytes = 0
  for (const column of QUEUED_TEXT_COLUMNS) {
    const value = row[column]
    bytes += typeof value === 'string' ? Buffer.byteLength(value) : 0
  }
  return bytes
}

function oversizedQueue(): JournalLegacyRetentionError {
  return new JournalLegacyRetentionError(
    'an original chat holds more waiting text than this store keeps',
    'source-oversize'
  )
}

export function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)
}
