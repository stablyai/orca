// What a bot side chat still owes, read synchronously from keyed rows of this chat alone, so the same
// check can run in the end's fence tick and again in its commit. A read that fails counts as owed.
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../shared/agent-session/identity/orca-session-address'
import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import type { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import type { BotChatEndReason } from '../../../shared/bots/bot-chat-end'

export type BotChatEndObligationSources = {
  db: OrchestrationDb
  /** The bot's automations, read from memory. */
  automations: () => readonly Pick<Automation, 'id' | 'name' | 'bot'>[]
  /** Runs not yet final into the named chats (retention never prunes those), from an index by chat. */
  activeRunsInto: (
    chatSessionIds: readonly string[]
  ) => readonly Pick<AutomationRun, 'automationId' | 'chatSessionId'>[]
  /** A connector delivery is being sent to, or waits on, this session's turn. */
  deliveryPending: (sessionId: string) => boolean
}

const OPEN_REQUEST_PURPOSES = "('question', 'handoff')"

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

function count(db: OrchestrationDb, sql: string, values: readonly string[]): number {
  const n: unknown = db.db.prepare(sql).get(...values)?.n
  return typeof n === 'number' ? n : 0
}

function exists(db: OrchestrationDb, sql: string, values: readonly string[]): boolean {
  return db.db.prepare(sql).get(...values) !== undefined
}

/** Coordinated a Run: PR 1's permanent refusal, finished or not. */
function coordinatedRun(db: OrchestrationDb, ids: readonly string[]): boolean {
  const i = placeholders(ids)
  return exists(db, `SELECT 1 FROM runs WHERE coordinator_orca_session_id IN (${i}) LIMIT 1`, ids)
}

const OPEN_DISPATCH = "status IN ('pending', 'dispatched')"

/** Dispatches not final yet that it created or was given; a finished one owes nothing. */
function openDispatches(db: OrchestrationDb, ids: readonly string[], addresses: readonly string[]) {
  const i = placeholders(ids)
  const a = placeholders(addresses)
  return count(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT id FROM dispatch_contexts WHERE creator_orca_session_id IN (${i}) AND ${OPEN_DISPATCH}
       UNION SELECT id FROM dispatch_contexts WHERE assignee_orca_session_id IN (${i}) AND ${OPEN_DISPATCH}
       UNION SELECT id FROM dispatch_contexts WHERE assignee_handle IN (${a}) AND ${OPEN_DISPATCH}
     )`,
    [...ids, ...ids, ...addresses]
  )
}

/** Orchestration questions with no answer, read or not, on any Dispatch the chat was given, finished
 *  or not: the ones it asked (a finished worker still asks) and the ones its workers asked of it. */
function openQuestions(db: OrchestrationDb, ids: readonly string[], addresses: readonly string[]) {
  const mine = `SELECT id FROM dispatch_contexts WHERE assignee_orca_session_id IN (${placeholders(ids)})
    UNION SELECT id FROM dispatch_contexts WHERE assignee_handle IN (${placeholders(addresses)})`
  const values = [...ids, ...addresses]
  return {
    askedBy: count(
      db,
      `SELECT COUNT(*) AS n FROM question_threads
       WHERE dispatch_id IN (${mine}) AND status = 'pending'`,
      values
    ),
    askedOf: count(
      db,
      `SELECT COUNT(*) AS n FROM messages m JOIN question_threads q ON q.message_id = m.id
       WHERE m.to_handle IN (SELECT 'dispatch:' || id FROM (${mine})) AND q.status = 'pending'`,
      values
    )
  }
}

/** The message types a reply carries. Anything else (a question, heartbeat, Dispatch, report,
 *  escalation, decision gate or merge-ready) never answers a question: it stays held. */
const ANSWER_TYPES = "('status', 'handoff')"

/**
 * Point-to-point questions with no bot request behind them and no answer yet: read ones to the
 * chat (unread ones count as unread), and ones it sent. One rule, no thread inference: an answer
 * names the question in its payload (`{"replyTo": <question id>}`, which `orchestration reply`
 * writes), comes from the one it was asked of (any address of the chat's lineage when asked of the
 * chat), goes back to the one who asked, is newer than it and has a reply's type. Anything looser
 * could take other mail for the answer and end the chat while the real answer is owed, which the
 * guard would then refuse and lose. Replies are looked for only in the question's thread, where
 * `orchestration reply` always puts them: each thread once, above its oldest question, for all of
 * its questions, then matched to them by the id they name.
 *
 * Held, the recoverable side ("N questions waiting for a reply"); x still moves the tab to the
 * background, and nothing overrides it:
 * - a recipient that never answers;
 * - an answer to a question the chat asked that comes from another address of the one asked
 *   (say a /clear successor of an Orca session it asked): only the address asked answers;
 * - an answer with no `replyTo`: from an older Orca, from before replies named their question, or
 *   sent with `send --thread-id`. The chat can clear a question asked of it by replying again; one
 *   it asked clears only when the other side replies again, so with that side gone it never ends;
 * - an answer of another type (worker_done, escalation, decision_gate, merge_ready, dispatch);
 * - a question that reached the chat over peer mail without becoming a bot request: peer-mail
 *   replies are not stored as local messages, so it never clears (probably unreachable).
 */
/** The two counts' queries, apart so a test can check their plans: each question thread is one
 *  seek, and a reply is matched to its question by the id it names, never by a scan of messages. */
export function plainQuestionQueries(
  addresses: readonly string[]
): Record<'askedOf' | 'askedBy', { sql: string; values: string[] }> {
  const a = placeholders(addresses)
  // `ours`: the reply's side that is the chat, known up front, so candidates are cut before any
  // JSON is read; `theirs`: the side that must be the question's other party.
  const unanswered = (
    asker: 'to_handle' | 'from_handle',
    extra: string,
    ours: string,
    theirs: string
  ) => ({
    sql: `WITH q AS MATERIALIZED (
         SELECT m.id, m.sequence, m.from_handle, m.to_handle, COALESCE(m.thread_id, m.id) AS thread
           FROM messages m
          WHERE m.${asker} IN (${a}) ${extra} AND m.type = 'question'
            AND NOT EXISTS (SELECT 1 FROM bot_requests r WHERE r.message_id = m.id)
       ),
       threads AS MATERIALIZED (SELECT thread, MIN(sequence) AS after FROM q GROUP BY thread),
       replies AS MATERIALIZED (
         SELECT msg.sequence, msg.from_handle, msg.to_handle,
                CASE WHEN json_valid(msg.payload) THEN json_extract(msg.payload, '$.replyTo') END
                  AS reply_to
           -- CROSS JOIN keeps each thread's seek in the lead; the inbox is never walked.
           FROM threads t CROSS JOIN messages msg
             ON msg.thread_id = t.thread AND msg.sequence > t.after
          WHERE msg.type IN ${ANSWER_TYPES} AND ${ours} AND msg.payload LIKE '%"replyTo"%'
       ),
       answered AS (
         SELECT DISTINCT q.id FROM replies x JOIN q ON q.id = x.reply_to
          WHERE x.sequence > q.sequence AND ${theirs}
       )
       SELECT COUNT(*) AS n FROM q WHERE q.id NOT IN (SELECT id FROM answered)`,
    values: [...addresses, ...addresses]
  })
  return {
    // Asked of the chat: any address of its lineage answers, back to the asker.
    askedOf: unanswered(
      'to_handle',
      'AND m.read = 1',
      `+msg.from_handle IN (${a})`,
      'x.to_handle = q.from_handle'
    ),
    // Asked by the chat: the one it asked answers, back to any address of the chat.
    askedBy: unanswered(
      'from_handle',
      "AND m.type <> 'heartbeat'",
      `+msg.to_handle IN (${a})`,
      'x.from_handle = q.to_handle'
    )
  }
}

function plainQuestions(db: OrchestrationDb, addresses: readonly string[]) {
  const { askedOf, askedBy } = plainQuestionQueries(addresses)
  return {
    askedOf: count(db, askedOf.sql, askedOf.values),
    askedBy: count(db, askedBy.sql, askedBy.values)
  }
}

function mailReasons(db: OrchestrationDb, ids: readonly string[]): BotChatEndReason[] {
  const addresses = ids.flatMap((id) => (isOrcaSessionId(id) ? [formatOrcaSessionAddress(id)] : []))
  const a = placeholders(addresses)
  const reasons: BotChatEndReason[] = []
  if (coordinatedRun(db, ids)) {
    reasons.push({ kind: 'ran-workers' })
  }
  const dispatches = openDispatches(db, ids, addresses)
  if (dispatches > 0) {
    reasons.push({ kind: 'dispatch', count: dispatches })
  }
  const unread = count(
    db,
    `SELECT COUNT(*) AS n FROM messages WHERE to_handle IN (${a}) AND read = 0`,
    addresses
  )
  if (unread > 0) {
    reasons.push({ kind: 'unread', count: unread })
  }
  const unanswered = (column: 'to_handle' | 'from_handle', extra: string) =>
    count(
      db,
      `SELECT COUNT(*) AS n FROM messages m
         JOIN bot_requests r ON r.message_id = m.id
         LEFT JOIN bot_request_outcomes o ON o.message_id = m.id
       WHERE m.${column} IN (${a}) ${extra}
         AND r.purpose IN ${OPEN_REQUEST_PURPOSES} AND o.message_id IS NULL`,
      addresses
    )
  const questions = openQuestions(db, ids, addresses)
  const plain = plainQuestions(db, addresses)
  // Unread ones are counted above; a read status asks nothing.
  const asked = unanswered('to_handle', 'AND m.read = 1') + questions.askedOf + plain.askedOf
  if (asked > 0) {
    reasons.push({ kind: 'requests', count: asked })
  }
  const waiting =
    unanswered('from_handle', "AND m.type <> 'heartbeat'") + questions.askedBy + plain.askedBy
  if (waiting > 0) {
    reasons.push({ kind: 'questions', count: waiting })
  }
  if (ids.some((id) => db.getStructuredMailSendMailboxesForSession(id).length > 0)) {
    reasons.push({ kind: 'replying' })
  }
  return reasons
}

function automationReasons(
  sources: BotChatEndObligationSources,
  botId: string,
  ids: readonly string[]
): BotChatEndReason[] {
  const own = sources.automations().filter((automation) => automation.bot?.botId === botId)
  const reasons: BotChatEndReason[] = own
    .filter((automation) => ids.includes(automation.bot?.chat?.sessionId ?? ''))
    .map((automation) => ({ kind: 'automation', name: automation.name }))
  const ownIds = new Set(own.map((automation) => automation.id))
  const going = sources.activeRunsInto(ids).some((run) => ownIds.has(run.automationId))
  return going ? [...reasons, { kind: 'automation-run' }] : reasons
}

/** Every reason the chat cannot end now; empty when it owes nothing. Throws on an unreadable source. */
export function botChatEndObligations(
  sources: BotChatEndObligationSources,
  botId: string,
  lineage: readonly string[]
): BotChatEndReason[] {
  return [
    ...mailReasons(sources.db, lineage),
    ...automationReasons(sources, botId, lineage),
    ...(lineage.some(sources.deliveryPending) ? [{ kind: 'replying' } as const] : [])
  ]
}
