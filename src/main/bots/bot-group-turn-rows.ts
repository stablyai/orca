import type { z } from 'zod'
import type { BotGroupTurnRows } from '../../shared/bots/bot-group'
import { requireStructuredHost } from './bot-chat-session'
import type { JournalRoomTurnPage } from '../native-chat/agent-session-journal/journal-domain-room-turn-page'
import {
  boundHistoryItemsByBytes,
  HISTORY_PAGE_CONTENT_BUDGET_BYTES
} from '../native-chat/agent-session-wire/publication/history/agent-session-history-page-bounds'
import { agentJournalItemForWire } from '../native-chat/agent-session-wire/publication/history/agent-session-item-wire-form'
import type { BotGroupRuntime } from './bot-group-runtime'

/** A room's own operation, requested only while its details are open. */
export async function readBotGroupTurnRows(
  groups: BotGroupRuntime,
  { groupId, threadId, operationId, beforeSequence }: z.infer<typeof BotGroupTurnRows>,
  signal?: AbortSignal
): Promise<JournalRoomTurnPage> {
  signal?.throwIfAborted()
  const message = groups.store.operationMessage(operationId)
  const turn = message?.turns.find((candidate) => candidate.operationId === operationId)
  if (!message || message.groupId !== groupId || message.threadId !== threadId || !turn) {
    return { items: [] }
  }
  if (turn.frozenItems) {
    const candidates = turn.frozenItems.filter(
      (item) => item.sequence < (beforeSequence ?? Infinity)
    )
    const { items, dropped } = boundHistoryItemsByBytes(
      candidates,
      'newest',
      new Map(),
      HISTORY_PAGE_CONTENT_BUDGET_BYTES,
      agentJournalItemForWire
    )
    return { items, ...(dropped > 0 && items.length ? { beforeSequence: items[0].sequence } : {}) }
  }
  const reads = await (await requireStructuredHost(groups.runtime)).journalReads(turn.sessionId)
  signal?.throwIfAborted()
  return reads.roomTurnPage(
    {
      operationId,
      turnItemId: turn.turnItemId,
      workerDispatchIds: turn.workerDispatchIds,
      beforeSequence
    },
    signal
  )
}
