// What the orchestration records say about one bot chat for the chat-tab tidy, read synchronously from
// keyed rows of this chat's own ids and addresses: whether Orca started it for a bot request, whether it
// still owes or waits on anything, and when mail last moved. A read that fails throws (the tidy skips).
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../shared/agent-session/identity/orca-session-address'
import { isMarkedBotRequestChat } from '../runtime/orchestration/db/bot-requests/bot-request-chats-store'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'

/** How soon after a chat was created its first mail must be a bot request for it to count as one
 *  `--chat new` started, when it predates the durable mark. */
export const REQUEST_CHAT_FIRST_MAIL_WITHIN_MS = 10 * 60 * 1000

export type BotChatTabFacts = {
  /** Orca started the chat for a bot request: its durable mark, or (older chats) its first mail. */
  requestChat: boolean
  /** Why it must keep its tab, empty when nothing holds it. */
  holds: BotChatTabHold[]
  /** Newest orchestration mail to or from it; null when none. */
  lastMailAt: number | null
}

export type BotChatTabHold = 'dispatch' | 'unread-mail' | 'question' | 'own-request' | 'sending'

type Db = Pick<OrchestrationDb, 'db' | 'getStructuredMailSendMailboxesForSession'>

const list = (values: readonly unknown[]): string => values.map(() => '?').join(', ')

function exists(db: Db, sql: string, values: readonly string[]): boolean {
  return values.length > 0 && db.db.prepare(sql).get(...values) !== undefined
}

/** SQLite's `datetime('now')` text (UTC, no zone) as epoch ms; null when unreadable. */
export function sqliteUtcMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null
  }
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? ms : null
}

function firstMailIsRequest(db: Db, address: string, chatCreatedAt: number | null): boolean {
  if (chatCreatedAt === null) {
    return false
  }
  const row: unknown = db.db
    .prepare(
      `SELECT m.created_at AS at,
              EXISTS (SELECT 1 FROM bot_requests r WHERE r.message_id = m.id) AS request
         FROM messages m WHERE m.to_handle = ? ORDER BY m.sequence LIMIT 1`
    )
    .get(address)
  if (!row || typeof row !== 'object' || !('request' in row) || row.request !== 1) {
    return false
  }
  const at = 'at' in row ? sqliteUtcMs(row.at) : null
  return (
    at !== null && at >= chatCreatedAt && at - chatCreatedAt <= REQUEST_CHAT_FIRST_MAIL_WITHIN_MS
  )
}

function holdsOf(db: Db, ids: readonly string[], addresses: readonly string[]): BotChatTabHold[] {
  const i = list(ids)
  const a = list(addresses)
  const holds: BotChatTabHold[] = []
  const open = "status IN ('pending', 'dispatched')"
  // A Dispatch it created or was given that is not final, whatever its terminal shows.
  if (
    exists(
      db,
      `SELECT 1 FROM dispatch_contexts WHERE creator_orca_session_id IN (${i}) AND ${open} LIMIT 1`,
      ids
    ) ||
    exists(
      db,
      `SELECT 1 FROM dispatch_contexts WHERE assignee_orca_session_id IN (${i}) AND ${open} LIMIT 1`,
      ids
    ) ||
    exists(
      db,
      `SELECT 1 FROM dispatch_contexts WHERE assignee_handle IN (${a}) AND ${open} LIMIT 1`,
      addresses
    )
  ) {
    holds.push('dispatch')
  }
  if (
    exists(db, `SELECT 1 FROM messages WHERE to_handle IN (${a}) AND read = 0 LIMIT 1`, addresses)
  ) {
    holds.push('unread-mail')
  }
  // Orchestration questions with no answer on a Dispatch it was given: asked by it, or of it.
  const given = `SELECT id FROM dispatch_contexts WHERE assignee_orca_session_id IN (${i})
    UNION SELECT id FROM dispatch_contexts WHERE assignee_handle IN (${a})`
  if (
    exists(
      db,
      `SELECT 1 FROM question_threads WHERE dispatch_id IN (${given}) AND status = 'pending' LIMIT 1`,
      [...ids, ...addresses]
    ) ||
    exists(
      db,
      `SELECT 1 FROM messages m JOIN question_threads q ON q.message_id = m.id
        WHERE m.to_handle IN (SELECT 'dispatch:' || id FROM (${given})) AND q.status = 'pending'
        LIMIT 1`,
      [...ids, ...addresses]
    )
  ) {
    holds.push('question')
  }
  // Its own question or handoff to a bot with no outcome yet: it waits on the answer. A request *to* it
  // with no outcome is not a hold: that is the request that failed or was left, which this tidies.
  if (
    exists(
      db,
      `SELECT 1 FROM messages m JOIN bot_requests r ON r.message_id = m.id
         LEFT JOIN bot_request_outcomes o ON o.message_id = m.id
        WHERE m.from_handle IN (${a}) AND m.type <> 'heartbeat'
          AND r.purpose IN ('question', 'handoff') AND o.message_id IS NULL LIMIT 1`,
      addresses
    )
  ) {
    holds.push('own-request')
  }
  if (ids.some((id) => db.getStructuredMailSendMailboxesForSession(id).length > 0)) {
    holds.push('sending')
  }
  return holds
}

function lastMailAt(db: Db, addresses: readonly string[]): number | null {
  if (addresses.length === 0) {
    return null
  }
  const a = list(addresses)
  const newest = (column: 'to_handle' | 'from_handle') => {
    const row: unknown = db.db
      .prepare(`SELECT MAX(created_at) AS at FROM messages WHERE ${column} IN (${a})`)
      .get(...addresses)
    return sqliteUtcMs(row && typeof row === 'object' && 'at' in row ? row.at : null)
  }
  const times = [newest('to_handle'), newest('from_handle')].filter((at) => at !== null)
  return times.length > 0 ? Math.max(...times) : null
}

/** `chatId` is the chat's root; `lineage` every session of it (root, /clear successors, tab sessions). */
export function readBotChatTabFacts(
  db: Db,
  input: { chatId: string; lineage: readonly string[]; chatCreatedAt: number | null }
): BotChatTabFacts {
  const ids = [...new Set([input.chatId, ...input.lineage])].filter(isOrcaSessionId)
  const addresses = ids.map((id) => formatOrcaSessionAddress(id))
  const requestChat =
    isOrcaSessionId(input.chatId) &&
    (isMarkedBotRequestChat(db, input.chatId) ||
      firstMailIsRequest(db, formatOrcaSessionAddress(input.chatId), input.chatCreatedAt))
  return {
    requestChat,
    holds: requestChat ? holdsOf(db, ids, addresses) : [],
    lastMailAt: requestChat ? lastMailAt(db, addresses) : null
  }
}
