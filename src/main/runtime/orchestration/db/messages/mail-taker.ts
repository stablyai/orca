// Who took an agent question: the party whose read commit took it, recorded once on the question's own
// row. A later read never moves it, so it names the actual taker even after mailboxes change hands.
import type { OrchestrationDb } from '../orchestration-db'
import { createChatOrcaSessionIdResolver } from '../../addressing/session-lineage/canonical-orca-session-id'

export type MailTaker =
  /** A chat, by its /clear lineage root. */
  | { kind: 'session'; sessionId: string }
  /** A terminal agent, by its handle: one terminal can show in two panes. */
  | { kind: 'terminal'; handle: string }
  /** A caller that is neither a chat nor a terminal agent. */
  | { kind: 'shell' }
  /** Read by answering it. */
  | { kind: 'reply' }
  /** Read by Orca itself: answer mail, rejections, the Run scheduler. */
  | { kind: 'orca' }
  /** Never read by its receiver: a person withdrew it, or it was dropped. */
  | { kind: 'dropped'; why: string }

/** A chat taker, by its /clear lineage root, so a successor's later turns still name the same taker. */
export function sessionMailTaker(sessionId: string): MailTaker {
  return { kind: 'session', sessionId: createChatOrcaSessionIdResolver()(sessionId) }
}

/** The party a consuming read hands its questions to: a terminal agent by its handle, a chat by its
 *  session, anything else as a shell. */
export function callerMailTaker(caller: {
  terminalHandle: string | null
  orcaSessionId: string | null
}): MailTaker {
  if (caller.terminalHandle) {
    return { kind: 'terminal', handle: caller.terminalHandle }
  }
  return caller.orcaSessionId ? sessionMailTaker(caller.orcaSessionId) : { kind: 'shell' }
}

export function mailTakerKey(taker: MailTaker): string {
  switch (taker.kind) {
    case 'session':
      return `session:${taker.sessionId}`
    case 'terminal':
      return `terminal:${taker.handle}`
    case 'dropped':
      return `dropped:${taker.why}`
    case 'shell':
    case 'reply':
    case 'orca':
      return taker.kind
  }
}

const QUESTION_TAKE_TABLES = [
  ['bot_requests', "purpose = 'question' AND "],
  ['question_threads', ''],
  ['remote_owned_questions', '']
] as const

// SPIKE: the kinds the shadow reconcile decides are marked awaiting when taken, unless already ended.
const AWAITING_WHEN_TAKEN: Record<(typeof QUESTION_TAKE_TABLES)[number][0], string> = {
  bot_requests: `CASE WHEN NOT EXISTS (SELECT 1 FROM bot_request_outcomes o
                   WHERE o.message_id = bot_requests.message_id) THEN 1 END`,
  question_threads: "CASE WHEN status = 'pending' THEN 1 END",
  remote_owned_questions: 'awaiting'
}

/** SPIKE: E4. Called after a take commits, with the taker key. */
export const questionTakeListeners = new Set<(takerKey: string) => void>()

/** Stamps the taker on these messages' question rows that have none, while the mail is still unread;
 *  callers run it in the same write as the read, or as the delivery that hands the question over. */
export function stampQuestionTakes(
  db: OrchestrationDb,
  ids: readonly string[],
  taker: MailTaker
): void {
  const key = mailTakerKey(taker)
  const placeholders = ids.map(() => '?').join(',')
  for (const [table, scope] of QUESTION_TAKE_TABLES) {
    db.db
      .prepare(
        `UPDATE ${table} SET taken_by = ?, awaiting = ${AWAITING_WHEN_TAKEN[table]}
         WHERE ${scope}taken_by IS NULL AND message_id IN (
           SELECT id FROM messages WHERE id IN (${placeholders}) AND read = 0)`
      )
      .run(key, ...ids)
  }
  if (questionTakeListeners.size > 0) {
    // After the caller's transaction commits (node:sqlite is synchronous).
    queueMicrotask(() => {
      for (const listener of questionTakeListeners) {
        listener(key)
      }
    })
  }
}

export function getQuestionTaker(db: OrchestrationDb, messageId: string): string | null {
  for (const [table] of QUESTION_TAKE_TABLES) {
    const row = db.db.prepare(`SELECT taken_by FROM ${table} WHERE message_id = ?`).get(messageId)
    if (row) {
      return typeof row.taken_by === 'string' ? row.taken_by : null
    }
  }
  return null
}
