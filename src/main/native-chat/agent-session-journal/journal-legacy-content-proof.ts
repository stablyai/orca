import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import {
  journalLegacyChatRevision,
  journalLegacyChatRevisionKey
} from './database/journal-legacy-source'
import { readStoredQueuedMessageRow } from './queued-messages/queued-message-stored-row'
import { isUnsettledQueuedMessage } from './queued-messages/queued-message-table'
import type Database from '../../sqlite/sync-database'

/** What the store must still do or decide for one original chat before the original can go. */
export type LegacySessionHold = {
  /** The store keeps this chat, so its history must be converted here. */
  convert: boolean
  /**
   * The original's own version of what both sides hold differently (its record, and text still
   * waiting to send), kept in this store verbatim before the original goes. Undefined when the
   * store already holds the same.
   */
  original?: string
}

export type LegacyClaim = { uploadId: string; sessionId: string; claimedAt: number }

/**
 * Whether this store holds everything the original holds for one chat, read from content: its
 * history revision, its record and the text queued to send. A difference the store can't show yet
 * keeps the original. Where both sides hold a chat differently (a person's name, options,
 * permission mode, or queued text), no content says which changed last, so the original's version
 * is returned to be kept here as well.
 */
export function legacySessionHold(
  source: Database.Database,
  store: Database.Database,
  sessionId: string,
  empty: boolean,
  hasQueue: boolean
): LegacySessionHold {
  // The reconcile tracks chats by record; history whose record an older Orca already removed is
  // only ever converted, as it was before this check.
  const recorded =
    hasTable(source, 'agent_session_records') &&
    !!source.prepare('SELECT 1 FROM agent_session_records WHERE session_id=?').get(sessionId)
  if (!recorded) {
    return { convert: true }
  }
  const revision = journalLegacyChatRevision(source, sessionId) ?? 'null'
  const shown = meta(store, journalLegacyChatRevisionKey(sessionId))
  const here = store
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM agent_session_records WHERE session_id=?1) AS recorded,
        (SELECT epoch FROM journal_chat_state WHERE session_id=?1) AS epoch,
        EXISTS(SELECT 1 FROM journal_chat_state WHERE session_id=?1) AS cataloged`
    )
    .get(sessionId)
  if (!here?.recorded && !here?.cataloged) {
    // Deleted here after reading this revision (its revision key stays): the person's choice.
    if (shown === revision || empty) {
      return { convert: false }
    }
    throw new JournalLegacyRetentionError('an original chat is not in this store yet')
  }
  // The reconcile hasn't read what an older Orca wrote since; the next launch's pass will.
  if (shown !== revision) {
    throw new JournalLegacyRetentionError('older Orca writes to a chat are not absorbed yet')
  }
  // A chat not converted yet takes its queue from the original as it is now when it converts.
  const converted = here.epoch !== null && here.epoch !== undefined
  return {
    convert: true,
    original:
      personEditsDiffer(source, store, sessionId) ||
      (converted && hasQueue && !queueHeld(source, store, sessionId))
        ? originalVersion(source, sessionId)
        : undefined
  }
}

/**
 * A chat the original records but never saved history for (a draft): nothing converts, but its
 * record and claims are weighed the same way.
 */
export function legacyRecordOnlyHold(
  source: Database.Database,
  store: Database.Database,
  sessionId: string
): LegacySessionHold {
  const recorded = store
    .prepare('SELECT 1 FROM agent_session_records WHERE session_id=?')
    .get(sessionId)
  if (!recorded) {
    // Deleted here after reading it, or a draft an older Orca made that this store never showed.
    const read = meta(store, journalLegacyChatRevisionKey(sessionId)) !== undefined
    return { convert: false, original: read ? undefined : originalVersion(source, sessionId) }
  }
  return {
    convert: false,
    original: personEditsDiffer(source, store, sessionId)
      ? originalVersion(source, sessionId)
      : undefined
  }
}

/**
 * One page of the original's attachment claims, in key order, returning those for chats this store
 * keeps that it doesn't claim yet. One indexed pass over the table, however many chats there are.
 */
export function readLegacyClaimsPage(
  source: Database.Database,
  store: Database.Database,
  after: [string, string] | null
): { claims: LegacyClaim[]; last: [string, string] | null } {
  const rows = source
    .prepare(
      `SELECT upload_id,session_id,claimed_at FROM agent_session_attachment_claims
      ${after === null ? '' : 'WHERE (upload_id,session_id)>(?,?)'}
      ORDER BY upload_id,session_id LIMIT 128`
    )
    .all(...(after ?? []))
  const kept = store.prepare('SELECT 1 FROM agent_session_records WHERE session_id=?')
  const held = store.prepare(
    'SELECT 1 FROM agent_session_attachment_claims WHERE upload_id=? AND session_id=?'
  )
  const claims: LegacyClaim[] = []
  for (const row of rows) {
    const uploadId = String(row.upload_id)
    const sessionId = String(row.session_id)
    if (kept.get(sessionId) && !held.get(uploadId, sessionId)) {
      claims.push({ uploadId, sessionId, claimedAt: Number(row.claimed_at) })
    }
  }
  const tail = rows.at(-1)
  return {
    claims,
    last: tail ? [String(tail.upload_id), String(tail.session_id)] : null
  }
}

/** Every message still waiting to send in the original is held here by id with the same text. */
function queueHeld(
  source: Database.Database,
  store: Database.Database,
  sessionId: string
): boolean {
  const card = store.prepare(`SELECT state,payload_json FROM journal_queue_cards
    WHERE session_id=? AND message_id=? ORDER BY epoch DESC LIMIT 1`)
  for (const row of source
    .prepare('SELECT * FROM queued_messages WHERE session_id=?')
    .iterate(sessionId)) {
    const queued = readStoredQueuedMessageRow(row)
    if (!queued) {
      return false
    }
    if (!isUnsettledQueuedMessage(queued)) {
      continue
    }
    const held = card.get(sessionId, queued.messageId)
    // The same text, waiting here or already acted on here; anything else is weighed by the caller.
    if (!held || !sameBody(held.payload_json, queued.body)) {
      return false
    }
  }
  return true
}

function sameBody(payload: unknown, body: unknown): boolean {
  try {
    const card: unknown = typeof payload === 'string' ? JSON.parse(payload) : null
    return (
      typeof card === 'object' &&
      card !== null &&
      'body' in card &&
      JSON.stringify(card.body) === JSON.stringify(body)
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
function personEditsDiffer(
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

/** The original's record and the text it still has waiting to send, verbatim. */
function originalVersion(source: Database.Database, sessionId: string): string {
  const record = source
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
    .get(sessionId)?.record_json
  const queued = hasTable(source, 'queued_messages')
    ? source
        .prepare(
          "SELECT * FROM queued_messages WHERE session_id=? AND state IN ('waiting','returned')"
        )
        .all(sessionId)
    : []
  return JSON.stringify({ version: 1, record: record ?? null, queued })
}

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)
}

function meta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM agent_session_store_meta WHERE key=?').get(key)
  return row === undefined ? undefined : String(row.value)
}

/** One page of the original's chats, those with history or only a record (a draft), held or not. */
export function readLegacyProofSessions(
  db: Database.Database,
  store: Database.Database,
  tables: ReadonlySet<string>,
  after: string | null
): (LegacySessionHold & {
  sessionId: string
  workspaceId: string
  epoch: string
  empty: boolean
})[] {
  const rows = db
    .prepare(
      `SELECT ids.session_id AS session_id, s.workspace_id AS workspace_id, s.epoch AS epoch
      FROM (SELECT session_id FROM journal_sessions
        ${tables.has('agent_session_records') ? 'UNION SELECT session_id FROM agent_session_records' : ''}) ids
      LEFT JOIN journal_sessions s ON s.session_id=ids.session_id
      ${after === null ? '' : 'WHERE ids.session_id>?'} ORDER BY ids.session_id LIMIT 32`
    )
    .all(...(after === null ? [] : [after]))
  return rows.map((row) => {
    const id = String(row.session_id)
    if (row.epoch === null) {
      return {
        sessionId: id,
        workspaceId: '',
        epoch: '',
        empty: true,
        ...legacyRecordOnlyHold(db, store, id)
      }
    }
    const hasRows = !!db.prepare('SELECT 1 FROM journal_rows WHERE session_id=? LIMIT 1').get(id)
    const hasQueue =
      tables.has('queued_messages') &&
      !!db.prepare('SELECT 1 FROM queued_messages WHERE session_id=? LIMIT 1').get(id)
    const empty =
      !hasRows &&
      !hasQueue &&
      (!tables.has('journal_outcome_epochs') ||
        !db.prepare('SELECT 1 FROM journal_outcome_epochs WHERE session_id=? LIMIT 1').get(id))
    return {
      sessionId: id,
      workspaceId: String(row.workspace_id),
      epoch: String(row.epoch),
      empty,
      ...legacySessionHold(db, store, id, empty, hasQueue)
    }
  })
}
