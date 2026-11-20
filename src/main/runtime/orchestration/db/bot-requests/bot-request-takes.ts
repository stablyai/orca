// Which chat took each agent question, until the question has an outcome. The chat's next rest
// decides it: answered by then, or its asker is told once.
import type { OrchestrationDb } from '../orchestration-db'
import { withinSavepoint, type BotRequestRelease, type BotRequestRow } from './bot-request-store'

/** Notes the chat that took a request, or the person who withdrew it unread. A request with an
 *  outcome is owed nothing, and a status asks for nothing, so neither is taken. */
export function takeBotRequest(
  this: OrchestrationDb,
  messageId: string,
  sessionId: string,
  by: 'agent' | BotRequestRelease
): boolean {
  return (
    this.db
      .prepare(
        `UPDATE bot_requests SET taken_session_id = ?, taken_by = ?
          WHERE message_id = ? AND purpose <> 'status'
            AND NOT EXISTS (SELECT 1 FROM bot_request_outcomes o WHERE o.message_id = ?)`
      )
      .run(sessionId, by, messageId, messageId).changes > 0
  )
}

/** A request its chat will never read is held as released, read, until its asker is told: the
 *  release outlasts a sender that can't be verified yet, and a restart. False once anything read it. */
export function releaseUnreadBotRequest(
  this: OrchestrationDb,
  messageId: string,
  sessionId: string,
  why: Exclude<BotRequestRelease, 'person'>
): boolean {
  return withinSavepoint(this, () => {
    const released =
      this.db
        .prepare(
          `UPDATE bot_requests SET taken_session_id = ?, taken_by = ?, debt_rule = 1
            WHERE message_id = ? AND taken_session_id IS NULL
              AND EXISTS (SELECT 1 FROM messages m WHERE m.id = ? AND m.read = 0)
              AND NOT EXISTS (SELECT 1 FROM bot_request_outcomes o WHERE o.message_id = ?)`
        )
        .run(sessionId, why, messageId, messageId, messageId).changes > 0
    if (released) {
      this.markAsRead([messageId])
    }
    return released
  })
}

/** Mail a `check` consumed: questions among it are taken by the checking chat, which the caller
 *  wakes once its transaction commits (true when any was). Read by no chat Orca can follow to rest
 *  (a terminal), they keep the earlier rule rather than a guessed one. */
export function noteBotRequestsChecked(
  this: OrchestrationDb,
  messageIds: readonly string[],
  sessionId: string | null
): boolean {
  let taken = false
  for (const messageId of messageIds) {
    if (sessionId) {
      taken = this.takeBotRequest(messageId, sessionId, 'agent') || taken
    } else {
      this.db
        .prepare(
          'UPDATE bot_requests SET debt_rule = NULL WHERE message_id = ? AND taken_session_id IS NULL'
        )
        .run(messageId)
    }
  }
  return taken
}

/** Requests one chat took under the new rule that still have no outcome. */
export function listOpenBotRequestTakes(this: OrchestrationDb, sessionId: string): BotRequestRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT r.* from bot_requests returns its columns, as BotRequestRow names them.
  return this.db
    .prepare(
      `SELECT r.* FROM bot_requests r INDEXED BY idx_bot_requests_open_take
        WHERE r.taken_session_id = ? AND r.debt_rule = 1
          AND NOT EXISTS (SELECT 1 FROM bot_request_outcomes o WHERE o.message_id = r.message_id)`
    )
    .all(sessionId) as BotRequestRow[]
}

/** Chats holding a request still owed an outcome under the new rule. */
export function listSessionsWithOpenBotRequestTakes(this: OrchestrationDb): string[] {
  return this.db
    .prepare(
      `SELECT DISTINCT taken_session_id FROM bot_requests INDEXED BY idx_bot_requests_open_take
        WHERE taken_session_id IS NOT NULL AND debt_rule = 1`
    )
    .all()
    .flatMap(({ taken_session_id }) =>
      typeof taken_session_id === 'string' ? [taken_session_id] : []
    )
}

/** The chats of one agent holding a question still owed an outcome: read before it is deleted. */
export function listSessionsWithOpenBotRequestTakesFor(
  this: OrchestrationDb,
  toBotId: string
): string[] {
  return this.db
    .prepare(
      `SELECT DISTINCT taken_session_id FROM bot_requests INDEXED BY idx_bot_requests_open_take
        WHERE taken_session_id IS NOT NULL AND debt_rule = 1 AND to_bot_id = ?`
    )
    .all(toBotId)
    .flatMap(({ taken_session_id }) =>
      typeof taken_session_id === 'string' ? [taken_session_id] : []
    )
}

/** A paired computer's request joins the new rule once its way back is filed. */
export function adoptBotRequestDebtRule(this: OrchestrationDb, messageId: string): string | null {
  // Not one a terminal already read: that one stays on the earlier rule.
  this.db
    .prepare(
      `UPDATE bot_requests SET debt_rule = 1 WHERE message_id = ?
         AND (taken_session_id IS NOT NULL
           OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = ? AND m.read = 1))`
    )
    .run(messageId, messageId)
  const row = this.db
    .prepare('SELECT taken_session_id FROM bot_requests WHERE message_id = ?')
    .get(messageId)
  return typeof row?.taken_session_id === 'string' ? row.taken_session_id : null
}

/** Whether this chat still holds this request, with no outcome: the fence a notice commits under. */
export function holdsBotRequestTake(
  this: OrchestrationDb,
  messageId: string,
  sessionId: string
): boolean {
  return (
    this.db
      .prepare(
        `SELECT 1 FROM bot_requests r WHERE r.message_id = ? AND r.taken_session_id = ?
           AND NOT EXISTS (SELECT 1 FROM bot_request_outcomes o WHERE o.message_id = r.message_id)`
      )
      .get(messageId, sessionId) !== undefined
  )
}

export type BotRequestTakeMethods = {
  takeBotRequest: typeof takeBotRequest
  releaseUnreadBotRequest: typeof releaseUnreadBotRequest
  noteBotRequestsChecked: typeof noteBotRequestsChecked
  listOpenBotRequestTakes: typeof listOpenBotRequestTakes
  listSessionsWithOpenBotRequestTakes: typeof listSessionsWithOpenBotRequestTakes
  listSessionsWithOpenBotRequestTakesFor: typeof listSessionsWithOpenBotRequestTakesFor
  adoptBotRequestDebtRule: typeof adoptBotRequestDebtRule
  holdsBotRequestTake: typeof holdsBotRequestTake
}

export function attachBotRequestTakes(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    takeBotRequest,
    releaseUnreadBotRequest,
    noteBotRequestsChecked,
    listOpenBotRequestTakes,
    listSessionsWithOpenBotRequestTakes,
    listSessionsWithOpenBotRequestTakesFor,
    adoptBotRequestDebtRule,
    holdsBotRequestTake
  })
}
