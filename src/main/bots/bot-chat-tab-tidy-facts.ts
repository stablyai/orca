// What the orchestration records say about one bot chat for the chat-tab tidy, read synchronously from
// keyed rows of the chat's own lineage (every session from its root to the one running it), so the same
// read runs before the close and again inside the hide's write. A read that fails throws: the tab stays.
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../shared/agent-session/identity/orca-session-address'
import { isMarkedBotRequestChat } from '../runtime/orchestration/db/bot-requests/bot-request-chats-store'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'

/** Why a chat keeps its tab, from its records. */
export type BotChatTabHold =
  | 'dispatch'
  | 'unread-mail'
  | 'owed-question'
  | 'dispatch-question'
  | 'run-question'
  | 'own-request'
  | 'incoming-mail'

export type BotChatTabFacts = {
  /** Holds, empty when nothing holds the tab. */
  holds: BotChatTabHold[]
  /** Newest non-heartbeat mail to or from any session of it, epoch ms; null when none. */
  lastMailAt: number | null
}

type Db = Pick<OrchestrationDb, 'db' | 'getStructuredMailSendMailboxesForSession'>

const OPEN_DISPATCH = "status IN ('pending', 'dispatched')"

function exists(db: Db, sql: string, ...values: string[]): boolean {
  return db.db.prepare(sql).get(...values) !== undefined
}

/** Only a chat Orca started for a bot request (its exclusive durable mark) is the tidy's. */
export function isBotRequestChat(db: Pick<OrchestrationDb, 'db'>, rootChatId: string): boolean {
  return isOrcaSessionId(rootChatId) && isMarkedBotRequestChat(db, rootChatId)
}

/** Each check is one keyed lookup per session id or address, on the index named beside it. */
function holdsOf(db: Db, rootChatId: string, ids: readonly string[]): BotChatTabHold[] {
  const addresses = ids.map((id) => formatOrcaSessionAddress(id))
  const holds = new Set<BotChatTabHold>()
  const any = (values: readonly string[], sql: string) =>
    values.some((value) => exists(db, sql, value))
  // A Dispatch it created or was given that is not final, whatever its terminal shows.
  if (
    any(
      ids,
      `SELECT 1 FROM dispatch_contexts WHERE creator_orca_session_id = ? AND ${OPEN_DISPATCH}`
    ) ||
    any(
      ids,
      `SELECT 1 FROM dispatch_contexts WHERE assignee_orca_session_id = ? AND ${OPEN_DISPATCH}`
    ) ||
    any(addresses, `SELECT 1 FROM dispatch_contexts WHERE assignee_handle = ? AND ${OPEN_DISPATCH}`)
  ) {
    holds.add('dispatch')
  }
  // idx_inbox (to_handle, read).
  if (any(addresses, 'SELECT 1 FROM messages WHERE to_handle = ? AND read = 0')) {
    holds.add('unread-mail')
  }
  // A question it took and still owes an answer or a notice: the *_awaiting partial indexes. A chat
  // takes as its /clear root.
  const taker = `session:${rootChatId}`
  if (
    exists(db, 'SELECT 1 FROM bot_requests WHERE taken_by = ? AND awaiting = 1', taker) ||
    exists(db, 'SELECT 1 FROM question_threads WHERE taken_by = ? AND awaiting = 1', taker) ||
    exists(db, 'SELECT 1 FROM remote_owned_questions WHERE taken_by = ? AND awaiting = 1', taker)
  ) {
    holds.add('owed-question')
  }
  // A pending question on a Dispatch it was given, asked by it or of it.
  const givenById = `SELECT id FROM dispatch_contexts WHERE assignee_orca_session_id = ?`
  const givenByHandle = `SELECT id FROM dispatch_contexts WHERE assignee_handle = ?`
  const pendingOn = (given: string) =>
    `SELECT 1 FROM question_threads q WHERE q.dispatch_id IN (${given}) AND q.status = 'pending'`
  const pendingTo = (given: string) =>
    `SELECT 1 FROM question_threads q JOIN messages m ON m.id = q.message_id
      WHERE m.to_handle IN (SELECT 'dispatch:' || id FROM (${given})) AND q.status = 'pending'`
  if (
    any(ids, pendingOn(givenById)) ||
    any(addresses, pendingOn(givenByHandle)) ||
    any(ids, pendingTo(givenById)) ||
    any(addresses, pendingTo(givenByHandle))
  ) {
    holds.add('dispatch-question')
  }
  // A pending question in a Run it coordinates (idx_runs_coordinator_orca_session_id,
  // idx_question_threads_run), its workers finished or not.
  if (
    any(
      ids,
      `SELECT 1 FROM runs r JOIN question_threads q ON q.run_id = r.id
        WHERE r.coordinator_orca_session_id = ? AND q.status = 'pending'`
    )
  ) {
    holds.add('run-question')
  }
  // Its own question or handoff to a bot with no outcome yet (idx_messages_crew_from).
  if (
    any(
      addresses,
      `SELECT 1 FROM messages m JOIN bot_requests r ON r.message_id = m.id
         LEFT JOIN bot_request_outcomes o ON o.message_id = m.id
        WHERE m.from_handle = ? AND m.type <> 'heartbeat'
          AND r.purpose IN ('question', 'handoff') AND o.message_id IS NULL`
    )
  ) {
    holds.add('own-request')
  }
  // Mail being handed into it (incoming pointer custody).
  if (ids.some((id) => db.getStructuredMailSendMailboxesForSession(id).length > 0)) {
    holds.add('incoming-mail')
  }
  return [...holds]
}

/** SQLite's julian day as epoch ms; null when absent. */
function julianMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round((value - 2440587.5) * 86_400_000)
    : null
}

/** Newest non-heartbeat mail per address and direction, each a max lookup on
 *  idx_messages_crew_to / idx_messages_crew_from (handle, julianday(created_at)). */
function lastMailAt(db: Db, addresses: readonly string[]): number | null {
  const newest = (column: 'to_handle' | 'from_handle', address: string) => {
    const row: unknown = db.db
      .prepare(
        `SELECT MAX(julianday(created_at)) AS at FROM messages
          WHERE ${column} = ? AND type <> 'heartbeat'`
      )
      .get(address)
    return julianMs(row && typeof row === 'object' && 'at' in row ? row.at : null)
  }
  const times = addresses.flatMap((address) =>
    [newest('to_handle', address), newest('from_handle', address)].filter((at) => at !== null)
  )
  return times.length > 0 ? Math.max(...times) : null
}

/** `rootChatId`: the chat's /clear root; `lineage`: every session from the root to the running one. */
export function readBotChatTabFacts(
  db: Db,
  input: { rootChatId: string; lineage: readonly string[] }
): BotChatTabFacts {
  const ids = [...new Set([input.rootChatId, ...input.lineage])].filter(isOrcaSessionId)
  return {
    holds: holdsOf(db, input.rootChatId, ids),
    lastMailAt: lastMailAt(
      db,
      ids.map((id) => formatOrcaSessionAddress(id))
    )
  }
}
