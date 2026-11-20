// Mail one bot (or something acting for one) sent another, with the record Orca wrote for it: who asked,
// where, and for which original message. Its own table, made on every open like the removed-work
// record; changes to it are numbered migrations (migrate-v48).
import type { MessageRow } from '../orchestration-records'
import type { MessageInsert } from '../messages/message-insert'
import type { OrchestrationDb } from '../orchestration-db'
import type { BotRequestPurpose } from '../../../../bots/bot-request-policy'

export const BOT_REQUEST_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bot_requests (
  message_id  TEXT PRIMARY KEY,
  root_key    TEXT NOT NULL,
  from_bot_id TEXT,
  to_bot_id   TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK(purpose IN ('status', 'handoff', 'question')),
  depth       INTEGER NOT NULL,
  record      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  send_key    TEXT,
  debt_rule   INTEGER,
  taken_session_id TEXT,
  taken_by    TEXT
);
`

/** Why a request was released before its chat read it. */
export type BotRequestRelease = 'person' | 'paused' | 'deleted' | 'new-chat'

export type BotRequestRow = {
  message_id: string
  root_key: string
  from_bot_id: string | null
  to_bot_id: string
  purpose: BotRequestPurpose
  depth: number
  /** JSON the host wrote; see BotRequestRecord. */
  record: string
  created_at: string
  /** One send from one turn: its sender, target, purpose and text; null on rows before it. */
  send_key: string | null
  /** 1: its asker is told once when the chat that took it rests unanswered; null: the earlier rule. */
  debt_rule: number | null
  /** The chat that took it, until it has an outcome. */
  taken_session_id: string | null
  /** 'agent': the chat read it; otherwise released unread: 'person' withdrew it, or its agent was
   *  paused or deleted, or its Chat replaced. */
  taken_by: 'agent' | BotRequestRelease | null
}

export type BotRequestAdmission =
  | { kind: 'sent'; message: MessageRow }
  | { kind: 'duplicate'; messageId: string }
  /** The same send already went unanswered. */
  | { kind: 'unanswered'; messageId: string }

const SAVEPOINT = 'bot_request_admission'

/**
 * Stores the mail and its request record together, or neither: the same send again while the first
 * is still open returns the first.
 */
export function admitBotRequest(
  this: OrchestrationDb,
  input: {
    rootKey: string
    /** The send's sender turn, target, purpose and text; absent for a send no turn names. */
    sendKey?: string
    fromBotId: string | null
    toBotId: string
    purpose: BotRequestPurpose
    depth: number
    record: string
    /** Its asker is told once if the chat that takes it rests without answering. */
    debtRule?: boolean
    /** A paired computer's request: its way back is filed with it, so no crash parts them. */
    peerLink?: BotRequestPeerLink
    message: MessageInsert
  }
): BotRequestAdmission {
  return withinSavepoint(this, () => admitWithin(this, input))
}

export type BotRequestPeerLink = {
  conversationId: string
  peerFingerprint: string
  senderLabel: string
}

export function withinSavepoint<T>(db: OrchestrationDb, work: () => T): T {
  db.db.exec(`SAVEPOINT ${SAVEPOINT}`)
  try {
    const result = work()
    db.db.exec(`RELEASE ${SAVEPOINT}`)
    return result
  } catch (error) {
    db.db.exec(`ROLLBACK TO ${SAVEPOINT}`)
    db.db.exec(`RELEASE ${SAVEPOINT}`)
    throw error
  }
}

type AdmissionKey = Pick<Parameters<typeof admitBotRequest>[0], 'sendKey' | 'purpose'>

/** Why this request can't reach this bot now: the same send is still open. A new request to a bot
 *  the chain already reached is no duplicate. */
export function botRequestBlocked(
  this: OrchestrationDb,
  input: AdmissionKey
): Exclude<BotRequestAdmission, { kind: 'sent' }> | null {
  // Status holds no place: information sent twice is sent twice.
  if (input.sendKey && input.purpose !== 'status') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bot_requests schema above pins message_id as TEXT; the adapter exposes unknown.
    const earlier = this.db
      .prepare(
        `SELECT r.message_id, o.outcome FROM bot_requests r
         LEFT JOIN bot_request_outcomes o ON o.message_id = r.message_id
         WHERE r.send_key = ?
           AND (o.message_id IS NULL OR (o.outcome = 'unanswered' AND r.debt_rule = 1))
         ORDER BY o.message_id IS NOT NULL LIMIT 1`
      )
      .get(input.sendKey) as { message_id: string; outcome: string | null } | undefined
    if (earlier) {
      // The same send after Orca said it went unanswered would only go unanswered again.
      return earlier.outcome === 'unanswered'
        ? { kind: 'unanswered', messageId: earlier.message_id }
        : { kind: 'duplicate', messageId: earlier.message_id }
    }
  }
  return null
}

function admitWithin(
  db: OrchestrationDb,
  input: Parameters<typeof admitBotRequest>[0]
): BotRequestAdmission {
  const blocked = db.botRequestBlocked(input)
  if (blocked) {
    return blocked
  }
  const message = db.insertMessage(input.message)
  insertRequestRow(db, message.id, input)
  if (input.peerLink) {
    db.linkPeerMailMessage({ ...input.peerLink, messageId: message.id })
  }
  return { kind: 'sent', message }
}

type BotRequestReservation = Omit<Parameters<typeof admitBotRequest>[0], 'message'> & {
  messageId: string
}

/**
 * Holds a request's place before anything is made for it (a new chat): the same dedupe as
 * admission, decided and stored at once, so a competing send gets this one as its duplicate.
 * `admitReservedBotRequest` then stores the mail; `releaseBotRequest` gives the place back.
 */
export function reserveBotRequest(
  this: OrchestrationDb,
  input: BotRequestReservation
): Exclude<BotRequestAdmission, { kind: 'sent' }> | { kind: 'reserved' } {
  const blocked = this.botRequestBlocked(input)
  if (blocked) {
    return blocked
  }
  insertRequestRow(this, input.messageId, input)
  return { kind: 'reserved' }
}

/** Stores the mail of a reserved request under the id it was reserved with. */
export function admitReservedBotRequest(
  this: OrchestrationDb,
  message: MessageInsert & { id: string },
  peerLink?: BotRequestPeerLink
): MessageRow {
  if (!this.getBotRequest(message.id)) {
    throw new Error(`bot request ${message.id} is not reserved`)
  }
  return withinSavepoint(this, () => {
    const stored = this.insertMessage(message)
    if (peerLink) {
      this.linkPeerMailMessage({ ...peerLink, messageId: stored.id })
    }
    return stored
  })
}

/** Gives back a reserved place whose mail was never stored. */
export function releaseBotRequest(this: OrchestrationDb, messageId: string): void {
  if (this.getMessageById(messageId)) {
    return
  }
  this.db.prepare('DELETE FROM bot_requests WHERE message_id = ?').run(messageId)
}

function insertRequestRow(
  db: OrchestrationDb,
  messageId: string,
  input: Omit<BotRequestReservation, 'messageId'>
): void {
  db.db
    .prepare(
      `INSERT INTO bot_requests
         (message_id, root_key, from_bot_id, to_bot_id, purpose, depth, record, send_key, debt_rule)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      messageId,
      input.rootKey,
      input.fromBotId,
      input.toBotId,
      input.purpose,
      input.depth,
      input.record,
      input.sendKey ?? null,
      input.debtRule ? 1 : null
    )
}

export function getBotRequest(this: OrchestrationDb, messageId: string): BotRequestRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * from the bot_requests schema above returns its columns, as BotRequestRow names them.
  return this.db.prepare('SELECT * FROM bot_requests WHERE message_id = ?').get(messageId) as
    | BotRequestRow
    | undefined
}

export type BotRequestStoreMethods = {
  admitBotRequest: typeof admitBotRequest
  reserveBotRequest: typeof reserveBotRequest
  admitReservedBotRequest: typeof admitReservedBotRequest
  releaseBotRequest: typeof releaseBotRequest
  botRequestBlocked: typeof botRequestBlocked
  getBotRequest: typeof getBotRequest
}

export function attachBotRequestStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    admitBotRequest,
    reserveBotRequest,
    admitReservedBotRequest,
    releaseBotRequest,
    botRequestBlocked,
    getBotRequest
  })
}
