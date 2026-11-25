import type { z } from 'zod'
import type { BotGroupTurnRows } from '../../shared/bots/bot-group'
import { requireStructuredHost } from './bot-chat-session'
import type { BotGroupTurnDetailPage } from '../../shared/bots/use-bot-group-turn-details'
import {
  boundHistoryItemsByBytes,
  HISTORY_PAGE_CONTENT_BUDGET_BYTES
} from '../native-chat/agent-session-wire/publication/history/agent-session-history-page-bounds'
import { agentJournalItemForWire } from '../native-chat/agent-session-wire/publication/history/agent-session-item-wire-form'
import type { BotGroupRuntime } from './bot-group-runtime'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'

const MAX_GROUP_DETAIL_READS = 8

/** A room's own operation, requested only while its details are open. */
export async function readBotGroupTurnRows(
  groups: BotGroupRuntime,
  input: z.infer<typeof BotGroupTurnRows>,
  signal?: AbortSignal
): Promise<BotGroupTurnDetailPage> {
  signal?.throwIfAborted()
  const reads = groups.turnDetailReads
  const key = JSON.stringify([input.groupId, input.threadId, input.operationId, input.before])
  const running = reads.get(key)
  if (running) {
    return waitForPromiseWithSignal(running, signal)
  }
  if (reads.size >= MAX_GROUP_DETAIL_READS) {
    throw new Error('Too many group turn detail reads are running.')
  }
  const page = readTurnPage(groups, input).finally(() => reads.delete(key))
  reads.set(key, page)
  return waitForPromiseWithSignal(page, signal)
}

async function readTurnPage(
  groups: BotGroupRuntime,
  { groupId, threadId, operationId, before }: z.infer<typeof BotGroupTurnRows>
): Promise<BotGroupTurnDetailPage> {
  const message = groups.store.operationMessage(operationId, false)
  const turn = message?.turns.find((candidate) => candidate.operationId === operationId)
  if (!message || message.groupId !== groupId || message.threadId !== threadId || !turn) {
    return { items: [] }
  }
  if (turn.frozenItems) {
    const end = Math.min(before?.journal?.[0] ?? Infinity, turn.frozenItems.length)
    const candidates = turn.frozenItems.slice(Math.max(0, end - 128), end)
    const { items, dropped } = boundHistoryItemsByBytes(
      candidates,
      'newest',
      new Map(),
      HISTORY_PAGE_CONTENT_BUDGET_BYTES,
      agentJournalItemForWire
    )
    const next = end - candidates.length + dropped
    return { items, ...(next > 0 ? { before: { journal: [next, 0, 0] } } : {}) }
  }
  const workers =
    !before || before.worker !== undefined
      ? groups.store.db
          .prepare(`SELECT rowid AS position, dispatch_id FROM bot_group_worker_operations
        WHERE operation_id=? AND rowid<? ORDER BY rowid DESC LIMIT 33`)
          .all(operationId, before?.worker ?? Number.MAX_SAFE_INTEGER)
      : []
  const reads = await (await requireStructuredHost(groups.runtime)).journalReads(turn.sessionId)
  const page = await reads.roomTurnPage({
    operationId,
    turnItemId: turn.turnItemId,
    workerDispatchIds: workers.slice(0, 32).map((worker) => String(worker.dispatch_id)),
    before: before?.journal,
    onlyWorkers: before !== undefined && before.journal === undefined
  })
  const worker = workers.length > 32 ? Number(workers[31].position) : undefined
  return {
    items: page.items,
    ...(page.before || worker !== undefined ? { before: { journal: page.before, worker } } : {})
  }
}
