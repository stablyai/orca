import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { BotGroupTurnDetailPage } from '../../shared/bots/use-bot-group-turn-details'
import { BotGroupTurnSchema } from '../../shared/bots/bot-group-schema'
import { BoundedMap } from '../../shared/collections/bounded-map'
import {
  boundHistoryItemsByBytes,
  HISTORY_PAGE_CONTENT_BUDGET_BYTES
} from '../native-chat/agent-session-wire/publication/history/agent-session-history-page-bounds'
import { agentJournalItemForWire } from '../native-chat/agent-session-wire/publication/history/agent-session-item-wire-form'
import type Database from '../sqlite/sync-database'

export type BotGroupTurnSourceInput = {
  groupId: string
  threadId?: string
  operationId: string
  messageId: string
  version: number
  before?: number
}

export type BotGroupTurnSource =
  | { kind: 'journal'; sessionId: string; turnItemId?: string }
  | { kind: 'frozen'; page: BotGroupTurnDetailPage }
  | null

type StoredTurn = {
  version: number
  groupId: string
  threadId?: string
  sessionId: string
  turnItemId?: string
  frozenItems?: AgentJournalRenderItem[]
  bytes: number
}

const TurnSourceSchema = BotGroupTurnSchema.pick({
  sessionId: true,
  turnItemId: true,
  frozenItems: true
})
const sources = new WeakMap<Database, BoundedMap<string, StoredTurn>>()

/** The orchestration reader owns the decoded frozen rows. Continuations slice the same immutable
 *  turn without transferring its siblings or reparsing the archived post. */
export function readBotGroupTurnSource(
  db: Database,
  input: BotGroupTurnSourceInput
): BotGroupTurnSource {
  let cached = sources.get(db)
  if (!cached) {
    cached = new BoundedMap({
      maxEntries: 160,
      maxBytes: 128 * 1024 * 1024,
      sizeOf: ({ bytes }) => bytes
    })
    sources.set(db, cached)
  }
  let turn = cached.get(input.operationId)
  if (turn?.version !== input.version) {
    const row = db
      .prepare(`SELECT turn.value AS record
      FROM bot_group_messages m, json_each(m.record, '$.turns') turn
      WHERE m.id=? AND m.group_id=? AND json_extract(m.record, '$.threadId') IS ?
        AND json_extract(turn.value, '$.operationId')=? LIMIT 1`)
      .get(input.messageId, input.groupId, input.threadId ?? null, input.operationId)
    if (!row || typeof row.record !== 'string') {
      return null
    }
    turn = {
      ...TurnSourceSchema.parse(JSON.parse(row.record)),
      version: input.version,
      groupId: input.groupId,
      threadId: input.threadId,
      bytes: row.record.length * 2 + 256
    }
    cached.set(input.operationId, turn)
  }
  if (turn.groupId !== input.groupId || turn.threadId !== input.threadId) {
    return null
  }
  if (!turn.frozenItems) {
    return { kind: 'journal', sessionId: turn.sessionId, turnItemId: turn.turnItemId }
  }
  const end = Math.min(input.before ?? turn.frozenItems.length, turn.frozenItems.length)
  const candidates = turn.frozenItems.slice(Math.max(0, end - 128), end)
  const { items, dropped } = boundHistoryItemsByBytes(
    candidates,
    'newest',
    new Map(),
    HISTORY_PAGE_CONTENT_BUDGET_BYTES,
    agentJournalItemForWire
  )
  const next = end - candidates.length + dropped
  return {
    kind: 'frozen',
    page: { items, ...(next > 0 ? { before: { journal: [next, 0, 0] } } : {}) }
  }
}
