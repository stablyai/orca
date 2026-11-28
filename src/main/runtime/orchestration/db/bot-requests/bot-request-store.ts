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
  send_key    TEXT
);
`

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
}

type BotRequestDuplicate = { kind: 'duplicate'; messageId: string }

export type BotRequestAdmission = { kind: 'sent'; message: MessageRow } | BotRequestDuplicate

/** One bot's quota to another. `refuse` throws, told when the oldest counted send leaves the window. */
export type BotRequestPairLimit = {
  requests: number
  minutes: number
  refuse: (oldestLeavesAt: number | null) => never
}

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
    message: MessageInsert
    /** Commits with the stored request, before anyone is woken for it. */
    onAdmitted?: () => void
    /** Counted and taken in the same synchronous step as the insert, so sends racing on one host
     *  can't pass it; absent for a send no bot makes. */
    pairLimit?: BotRequestPairLimit
  }
): BotRequestAdmission {
  return withinAdmission(this, () => {
    const admission = admitWithin(this, input)
    if (admission.kind === 'sent') {
      input.onAdmitted?.()
    }
    return admission
  })
}

function withinAdmission<T>(db: OrchestrationDb, write: () => T): T {
  db.db.exec(`SAVEPOINT ${SAVEPOINT}`)
  try {
    const result = write()
    db.db.exec(`RELEASE ${SAVEPOINT}`)
    return result
  } catch (error) {
    // An I/O error can end the whole transaction first; rolling back then would hide it.
    if (db.db.isTransaction) {
      db.db.exec(`ROLLBACK TO ${SAVEPOINT}`)
      db.db.exec(`RELEASE ${SAVEPOINT}`)
    }
    throw error
  }
}

type AdmissionKey = Pick<Parameters<typeof admitBotRequest>[0], 'sendKey' | 'purpose'>

/** Why this request can't reach this bot now: the same send is still open. A new request to a bot
 *  the chain already reached is no duplicate. */
export function botRequestBlocked(
  this: OrchestrationDb,
  input: AdmissionKey
): BotRequestDuplicate | null {
  // Status holds no place: information sent twice is sent twice.
  if (input.sendKey && input.purpose !== 'status') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bot_requests schema above pins message_id as TEXT; the adapter exposes unknown.
    const earlier = this.db
      .prepare(
        `SELECT r.message_id FROM bot_requests r
         LEFT JOIN bot_request_outcomes o ON o.message_id = r.message_id
         WHERE r.send_key = ? AND o.message_id IS NULL`
      )
      .get(input.sendKey) as { message_id: string } | undefined
    if (earlier) {
      return { kind: 'duplicate', messageId: earlier.message_id }
    }
  }
  return null
}

/** The same send again is its duplicate first; only a new one is held to the pair's quota. */
function refusedBeforeInsert(
  db: OrchestrationDb,
  input: Omit<Parameters<typeof admitBotRequest>[0], 'message'>
): BotRequestDuplicate | null {
  const blocked = db.botRequestBlocked(input)
  if (blocked || !input.pairLimit || !input.fromBotId) {
    return blocked
  }
  const pair = { fromBotId: input.fromBotId, toBotId: input.toBotId }
  const sent = db.botRequestsSentWithin(pair, input.pairLimit.minutes)
  return sent.count >= input.pairLimit.requests ? input.pairLimit.refuse(sent.oldestLeavesAt) : null
}

function admitWithin(
  db: OrchestrationDb,
  input: Parameters<typeof admitBotRequest>[0]
): BotRequestAdmission {
  const blocked = refusedBeforeInsert(db, input)
  if (blocked) {
    return blocked
  }
  const message = db.insertMessage(input.message)
  insertRequestRow(db, message.id, input)
  return { kind: 'sent', message }
}

type BotRequestReservation = Omit<
  Parameters<typeof admitBotRequest>[0],
  'message' | 'onAdmitted'
> & {
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
): BotRequestDuplicate | { kind: 'reserved' } {
  const blocked = refusedBeforeInsert(this, input)
  if (blocked) {
    return blocked
  }
  insertRequestRow(this, input.messageId, input)
  return { kind: 'reserved' }
}

/** Stores the mail of a reserved request under the id it was reserved with; `onAdmitted` commits with it. */
export function admitReservedBotRequest(
  this: OrchestrationDb,
  message: MessageInsert & { id: string },
  onAdmitted?: () => void
): MessageRow {
  if (!this.getBotRequest(message.id)) {
    throw new Error(`bot request ${message.id} is not reserved`)
  }
  return withinAdmission(this, () => {
    const stored = this.insertMessage(message)
    onAdmitted?.()
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
         (message_id, root_key, from_bot_id, to_bot_id, purpose, depth, record, send_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))`
    )
    .run(
      messageId,
      input.rootKey,
      input.fromBotId,
      input.toBotId,
      input.purpose,
      input.depth,
      input.record,
      input.sendKey ?? null
    )
}

export function getBotRequest(this: OrchestrationDb, messageId: string): BotRequestRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * from the bot_requests schema above returns its columns, as BotRequestRow names them.
  return this.db.prepare('SELECT * FROM bot_requests WHERE message_id = ?').get(messageId) as
    | BotRequestRow
    | undefined
}

/** A pair's requests in the window, read as a range of idx_bot_requests_pair: from the cutoff's whole
 *  second on, less the millisecond rows of that second at or before the cutoff. A whole-second row
 *  (from before milliseconds) in that second stays, counting to its second's end. */
const BOT_PAIR_WINDOW_SQL = `SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM bot_requests
  WHERE from_bot_id = ? AND to_bot_id = ?
    AND created_at >= strftime('%Y-%m-%d %H:%M:%S', 'now', ?)
    AND (created_at > strftime('%Y-%m-%d %H:%M:%f', 'now', ?) OR length(created_at) = 19)`

/** How many requests one bot made to another in the last `minutes` (reserved or admitted, delivered
 *  or not), and when the oldest of them goes out of that window (epoch ms; null with none). */
export function botRequestsSentWithin(
  this: OrchestrationDb,
  pair: { fromBotId: string; toBotId: string },
  minutes: number
): { count: number; oldestLeavesAt: number | null } {
  const window = `-${minutes} minutes`
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: COUNT and MIN over the bot_requests schema above.
  const row = this.db
    .prepare(BOT_PAIR_WINDOW_SQL)
    .get(pair.fromBotId, pair.toBotId, window, window) as {
    count: number
    oldest: string | null
  }
  // created_at is UTC 'YYYY-MM-DD HH:MM:SS.SSS' as the request was reserved or admitted, which is
  // when it takes its place; a row from before has whole seconds and counts to its second's end.
  const oldest = row.oldest ? Date.parse(`${row.oldest.replace(' ', 'T')}Z`) : Number.NaN
  return {
    count: row.count,
    oldestLeavesAt: Number.isNaN(oldest) ? null : oldest + minutes * 60_000
  }
}

export type BotRequestStoreMethods = {
  admitBotRequest: typeof admitBotRequest
  reserveBotRequest: typeof reserveBotRequest
  admitReservedBotRequest: typeof admitReservedBotRequest
  releaseBotRequest: typeof releaseBotRequest
  botRequestBlocked: typeof botRequestBlocked
  getBotRequest: typeof getBotRequest
  botRequestsSentWithin: typeof botRequestsSentWithin
}

export function attachBotRequestStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    admitBotRequest,
    reserveBotRequest,
    admitReservedBotRequest,
    releaseBotRequest,
    botRequestBlocked,
    botRequestsSentWithin,
    getBotRequest
  })
}
