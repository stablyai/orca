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
  /** A name the person set, options or permission mode differ between the original and here. */
  diverged: boolean
  /** Attachment claims only the original holds, taken into this store before it retires. */
  claims: LegacyClaim[]
}

export type LegacyClaim = { uploadId: string; sessionId: string; claimedAt: number }

/** Same key the older-Orca reconcile writes once it has read a chat's person edits. */
const PERSON_EDITS_KEY = 'journal.legacy-person-edits:'

/**
 * Whether this store holds everything the original holds for one chat, read from content: its
 * history revision, its record and the text queued to send. A difference the store can't show yet
 * keeps the original; a person-edit difference is reported for the caller to weigh.
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
  const recorded = !!source
    .prepare('SELECT 1 FROM agent_session_records WHERE session_id=?')
    .get(sessionId)
  if (!recorded) {
    return { convert: true, diverged: false, claims: missingClaims(source, store, sessionId) }
  }
  const revision = journalLegacyChatRevision(source, sessionId) ?? 'null'
  const shown = meta(store, journalLegacyChatRevisionKey(sessionId))
  const kept = store
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM agent_session_records WHERE session_id=?1)
        OR EXISTS(SELECT 1 FROM journal_chat_state WHERE session_id=?1) AS kept`
    )
    .get(sessionId)
  if (!kept?.kept) {
    // Deleted here after reading this revision (its revision key stays), or never held anything.
    if (shown === revision || empty) {
      return { convert: false, diverged: false, claims: [] }
    }
    throw new JournalLegacyRetentionError('an original chat is not in this store yet')
  }
  // The reconcile hasn't read what an older Orca wrote since; the next launch's pass will.
  if (shown !== revision) {
    throw new JournalLegacyRetentionError('older Orca writes to a chat are not absorbed yet')
  }
  if (hasQueue && !queueHeld(source, store, sessionId)) {
    throw new JournalLegacyRetentionError(
      'the original holds queued text this store does not',
      'source-queue-unheld'
    )
  }
  return {
    convert: true,
    diverged: personEditsDiverged(source, store, sessionId),
    claims: missingClaims(source, store, sessionId)
  }
}

/** Uploads the original claims for a chat this store keeps, which this store doesn't claim yet. */
function missingClaims(
  source: Database.Database,
  store: Database.Database,
  sessionId: string
): LegacyClaim[] {
  const held = store.prepare(
    'SELECT 1 FROM agent_session_attachment_claims WHERE upload_id=? AND session_id=?'
  )
  const missing: LegacyClaim[] = []
  for (const row of source
    .prepare('SELECT upload_id,claimed_at FROM agent_session_attachment_claims WHERE session_id=?')
    .iterate(sessionId)) {
    if (!held.get(String(row.upload_id), sessionId)) {
      missing.push({
        uploadId: String(row.upload_id),
        sessionId,
        claimedAt: Number(row.claimed_at)
      })
    }
  }
  return missing
}

/** Every message still waiting to send is held here by id with the same text, or was sent here. */
function queueHeld(
  source: Database.Database,
  store: Database.Database,
  sessionId: string
): boolean {
  const card = store.prepare(`SELECT state,payload_json FROM journal_queue_cards
    WHERE session_id=? AND message_id=? ORDER BY epoch DESC LIMIT 1`)
  const sent = store.prepare(`SELECT 1 FROM journal_submission_attempts
    WHERE session_id=? AND message_id=? LIMIT 1`)
  for (const row of source
    .prepare('SELECT * FROM queued_messages WHERE session_id=?')
    .iterate(sessionId)) {
    const queued = readStoredQueuedMessageRow(row)
    if (!queued) {
      return false
    }
    if (!isUnsettledQueuedMessage(queued) || sent.get(sessionId, queued.messageId)) {
      continue
    }
    const held = card.get(sessionId, queued.messageId)
    if (!held) {
      return false
    }
    // A card acted on here is newer than the original's waiting copy; a waiting one must match.
    if (
      (held.state === 'waiting' || held.state === 'returned') &&
      !sameBody(held.payload_json, queued.body)
    ) {
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

/**
 * A name the person set, options or permission mode that differ here from the original. Equal to
 * what the reconcile last read from the original means only this store changed them since.
 */
function personEditsDiverged(
  source: Database.Database,
  store: Database.Database,
  sessionId: string
): boolean {
  const read = (db: Database.Database) =>
    db
      .prepare(`SELECT ${PERSON_EDITS_SQL} AS edits FROM agent_session_records WHERE session_id=?`)
      .get(sessionId)?.edits
  const original = read(source)
  if (original === undefined || original === null) {
    return false
  }
  const here = read(store)
  if (here === original) {
    return false
  }
  // The reconcile's own baseline, in its format: unchanged since it read them means they're stale.
  const reconciled = source
    .prepare(`SELECT CASE WHEN json_valid(record_json) THEN json_extract(record_json,
      '$.conversationName','$.conversationNameSource','$.options','$.permissionMode') END AS edits
      FROM agent_session_records WHERE session_id=?`)
    .get(sessionId)?.edits
  const baseline = meta(store, `${PERSON_EDITS_KEY}${sessionId}`)
  return baseline === undefined || typeof reconciled !== 'string' || baseline !== reconciled
}

function meta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM agent_session_store_meta WHERE key=?').get(key)
  return row === undefined ? undefined : String(row.value)
}
