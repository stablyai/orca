// Who took an agent question: the party whose read commit took it, recorded once on the question's own
// row. A later read never moves it, so it names the actual taker even after mailboxes change hands.
import type { OrchestrationDb } from '../orchestration-db'
import { createChatOrcaSessionIdResolver } from '../../addressing/session-lineage/canonical-orca-session-id'
import { noteQuestionEdge } from './question-edges'

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

// The third column marks the asker as owed a notice: only for a kind whose notices this build
// decides (mailbox/questions/question-reconcile.ts), so a question taken earlier is never told late.
const QUESTION_TAKE_TABLES = [
  [
    'bot_requests',
    "purpose = 'question' AND ",
    `CASE WHEN NOT EXISTS (SELECT 1 FROM bot_request_outcomes o
       WHERE o.message_id = bot_requests.message_id) THEN 1 END`
  ],
  ['question_threads', '', "CASE WHEN status = 'pending' AND told IS NULL THEN 1 END"],
  ['remote_owned_questions', '', 'awaiting']
] as const

/** Stamps the taker on these messages' question rows that have none, while the mail is still unread;
 *  callers run it in the same write as the read, or as the delivery that hands the question over. */
export function stampQuestionTakes(
  db: OrchestrationDb,
  ids: readonly string[],
  taker: MailTaker
): void {
  const key = mailTakerKey(taker)
  const placeholders = ids.map(() => '?').join(',')
  let taken = false
  for (const [table, scope, awaiting] of QUESTION_TAKE_TABLES) {
    const changes = db.db
      .prepare(
        `UPDATE ${table} SET taken_by = ?, awaiting = ${awaiting}
         WHERE ${scope}taken_by IS NULL AND message_id IN (
           SELECT id FROM messages WHERE id IN (${placeholders}) AND read = 0)`
      )
      .run(key, ...ids).changes
    taken ||= changes > 0
  }
  if (taken) {
    noteQuestionEdge({ kind: 'take', taker: key })
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
