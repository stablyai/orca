import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { readCodexTurnStatus } from '../../app-server/codex-structured-thread-facts'
import { readRecord } from '../../app-server/codex-item-field-readers'
import type { CodexJournalTranslator } from '../journal/codex-structured-journal-contracts'
import {
  isCodexMessageItemType,
  readCodexThreadItem,
  type CodexThreadItem
} from '../items/codex-thread-item-identity'
import type { CodexBackgroundTaskTracker } from '../background-work/codex-background-task-tracker'
import {
  CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE,
  readReceiverThreadIds
} from '../items/codex-collab-agent-tool-call'

/** A chat with more subagents than this is past what one reattach looks up. */
const MAX_SEEDED_THREADS = 16

async function latestTurn(
  connection: Pick<CodexAppServerConnection, 'request'>,
  threadId: string,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const page = readRecord(
    await connection.request(
      'thread/turns/list',
      { threadId, sortDirection: 'desc', limit: 1, itemsView: 'full' },
      { timeoutMs }
    )
  )
  return Array.isArray(page.data) ? readRecord(page.data[0]) : null
}

/**
 * A reattached agent's running turns go on, but this app's message ordinals start empty, so the
 * turn's next message would take an earlier one's row. Each running turn (the chat's and its
 * subagents') is numbered from Codex's own history first, as the live run numbered it.
 */
export async function seedKeptCodexTurnOrdinals(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  translator: Pick<CodexJournalTranslator, 'seedTurnOrdinals'>
  threadId: string
  timeoutMs: number
  onError?: (threadId: string, error: unknown) => void
}): Promise<KeptCodexTurn[]> {
  const queue = [input.threadId]
  const seen = new Set<string>()
  const fetched: KeptCodexTurn[] = []
  while (queue.length > 0 && seen.size < MAX_SEEDED_THREADS) {
    const threadId = queue.shift() as string
    if (seen.has(threadId)) {
      continue
    }
    seen.add(threadId)
    const turn = await latestTurn(input.connection, threadId, input.timeoutMs).catch(
      (error: unknown) => {
        input.onError?.(threadId, error)
        return null
      }
    )
    if (!turn || typeof turn.id !== 'string') {
      continue
    }
    const items = (Array.isArray(turn.items) ? turn.items : []).flatMap(
      (value) => readCodexThreadItem(value) ?? []
    )
    const status = readCodexTurnStatus(turn)
    fetched.push({ threadId, turnId: turn.id, status, items })
    // A subagent spawned in a finished turn can still be running, so every spawn is followed.
    for (const item of items) {
      if (item.type === CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE) {
        queue.push(...readReceiverThreadIds(item))
      }
    }
    if (status === 'inProgress') {
      input.translator.seedTurnOrdinals(
        threadId,
        turn.id,
        items.filter((item) => isCodexMessageItemType(item.type)).map((item) => item.id)
      )
    }
  }
  return fetched
}

/** Each thread's latest turn as Codex reported it at reattach. */
export type KeptCodexTurn = {
  threadId: string
  turnId: string
  status: string | null
  items: CodexThreadItem[]
}

/**
 * Background commands and subagent turns that began before the reattach: the new session's tracker
 * never saw them start, so their rows would read "status unavailable". They are restated from the
 * same history, under the same task ids, without writing any chat row.
 */
export function restateKeptCodexBackgroundWork(
  tracker: Pick<CodexBackgroundTaskTracker, 'observe' | 'publishChildWork'>,
  turns: readonly KeptCodexTurn[]
): void {
  if (turns.length === 0) {
    return
  }
  for (const { threadId, turnId, status, items } of turns) {
    const turn = { id: turnId, status: status ?? 'inProgress' }
    if (status === 'inProgress') {
      tracker.observe({ method: 'turn/started', threadId, params: { turn } })
    }
    for (const item of items) {
      if (item.type === 'commandExecution' && item.status === 'inProgress') {
        tracker.observe({ method: 'item/started', threadId, params: { turnId, item } })
      }
    }
    // A finished turn's live commands are its background work, as when the turn ended live.
    if (status !== 'inProgress') {
      tracker.observe({ method: 'turn/completed', threadId, params: { turn } })
    }
  }
  tracker.publishChildWork()
}
