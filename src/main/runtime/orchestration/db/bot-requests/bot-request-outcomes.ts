// How each bot request ended, as Orca saw it: answered by mail, posted where the asker asked, ended
// with no answer, or dropped unread. The first outcome stands, but for an answer, which may follow
// any; Orca tells the sender at most once, and passes on one answer.
import type { MessageRow } from '../orchestration-records'
import type { OrchestrationDb } from '../orchestration-db'
import type { BotRequestRow } from './bot-request-store'

export const BOT_REQUEST_OUTCOMES = ['answered', 'posted', 'unanswered', 'dropped'] as const
export type BotRequestOutcome = (typeof BOT_REQUEST_OUTCOMES)[number]

export const BOT_REQUEST_OUTCOME_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bot_request_outcomes (
  message_id  TEXT PRIMARY KEY,
  outcome     TEXT NOT NULL CHECK(outcome IN ('answered', 'posted', 'unanswered', 'dropped')),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

/** Records an outcome unless one stands; true when this one was recorded. */
export function recordBotRequestOutcome(
  this: OrchestrationDb,
  messageId: string,
  outcome: BotRequestOutcome
): boolean {
  return (
    this.db
      .prepare('INSERT OR IGNORE INTO bot_request_outcomes (message_id, outcome) VALUES (?, ?)')
      .run(messageId, outcome).changes > 0
  )
}

/** Records a bot's answer by mail: the first, or the one after its post in the thread (`posted`);
 *  a late one after Orca said it couldn't still stands. Null for a second answer. */
export function recordBotAnswer(
  this: OrchestrationDb,
  messageId: string
): { posted: boolean } | null {
  const before = this.getBotRequestOutcome(messageId)
  if (before === 'answered') {
    return null
  }
  this.db
    .prepare(
      `INSERT INTO bot_request_outcomes (message_id, outcome) VALUES (?, 'answered')
       ON CONFLICT(message_id) DO UPDATE SET outcome = 'answered'`
    )
    .run(messageId)
  return { posted: before === 'posted' }
}

export function getBotRequestOutcome(
  this: OrchestrationDb,
  messageId: string
): BotRequestOutcome | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the CHECK above pins outcome to BotRequestOutcome; the adapter exposes unknown.
  const row = this.db
    .prepare('SELECT outcome FROM bot_request_outcomes WHERE message_id = ?')
    .get(messageId) as { outcome: BotRequestOutcome } | undefined
  return row?.outcome ?? null
}

/** Requests to a bot that no one has read yet and that have no outcome, with their mail. */
export function listUnreadBotRequests(
  this: OrchestrationDb,
  toBotId: string
): { request: BotRequestRow; message: MessageRow }[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the join selects bot_requests columns, as BotRequestRow names them, and the message id.
  const rows = this.db
    .prepare(
      `SELECT r.* FROM bot_requests r
       JOIN messages m ON m.id = r.message_id
       LEFT JOIN bot_request_outcomes o ON o.message_id = r.message_id
       WHERE r.to_bot_id = ? AND m.read = 0 AND o.message_id IS NULL`
    )
    .all(toBotId) as BotRequestRow[]
  return rows.flatMap((request) => {
    const message = this.getMessageById(request.message_id)
    return message ? [{ request, message }] : []
  })
}

/** Requests to an agent awaiting an answer that were read from these mailboxes and still have no
 *  outcome. Walks the agent's requests, far fewer than the mail its chats read. */
export function listReadOpenBotRequests(
  this: OrchestrationDb,
  toBotId: string,
  mailboxes: string[]
): string[] {
  if (mailboxes.length === 0) {
    return []
  }
  return this.db
    .prepare(
      `SELECT m.id FROM bot_requests r
       CROSS JOIN messages m ON m.id = r.message_id
       LEFT JOIN bot_request_outcomes o ON o.message_id = r.message_id
       WHERE r.to_bot_id = ? AND r.purpose != 'status' AND o.message_id IS NULL AND m.read = 1
         AND m.to_handle IN (${mailboxes.map(() => '?').join(', ')})
       ORDER BY m.sequence`
    )
    .all(toBotId, ...mailboxes)
    .flatMap((row) =>
      typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'string'
        ? [row.id]
        : []
    )
}

/** Whether the chat started a worker once this request reached it that is still open: its report
 *  wakes the chat again, still on the request. */
export function isBotRequestHeldByWorker(
  this: OrchestrationDb,
  orcaSessionId: string,
  messageId: string
): boolean {
  return (
    this.db
      .prepare(
        `SELECT 1 FROM messages m
         JOIN dispatch_contexts d ON d.creator_orca_session_id = ?
           AND d.status IN ('pending', 'dispatched')
           AND d.created_at >= COALESCE(m.delivered_at, m.created_at)
         WHERE m.id = ?
         LIMIT 1`
      )
      .get(orcaSessionId, messageId) !== undefined
  )
}

export type BotRequestOutcomeMethods = {
  recordBotRequestOutcome: typeof recordBotRequestOutcome
  recordBotAnswer: typeof recordBotAnswer
  getBotRequestOutcome: typeof getBotRequestOutcome
  listUnreadBotRequests: typeof listUnreadBotRequests
  listReadOpenBotRequests: typeof listReadOpenBotRequests
  isBotRequestHeldByWorker: typeof isBotRequestHeldByWorker
}

export function attachBotRequestOutcomes(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    recordBotRequestOutcome,
    recordBotAnswer,
    getBotRequestOutcome,
    listUnreadBotRequests,
    listReadOpenBotRequests,
    isBotRequestHeldByWorker
  })
}
