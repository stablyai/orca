import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { readCodexTurnStatus } from '../../app-server/codex-structured-thread-facts'
import { readRecord } from '../../app-server/codex-item-field-readers'
import type { CodexJournalTranslator } from '../journal/codex-structured-journal-contracts'
import { isCodexMessageItemType, readCodexThreadItem } from '../items/codex-thread-item-identity'
import {
  CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE,
  readReceiverThreadIds
} from '../items/codex-collab-agent-tool-call'

/** A chat with more subagents than this mid-turn is past what one reattach looks up. */
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
}): Promise<void> {
  const queue = [input.threadId]
  const seen = new Set<string>()
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
    if (!turn || typeof turn.id !== 'string' || readCodexTurnStatus(turn) !== 'inProgress') {
      continue
    }
    const items = (Array.isArray(turn.items) ? turn.items : []).flatMap(
      (value) => readCodexThreadItem(value) ?? []
    )
    input.translator.seedTurnOrdinals(
      threadId,
      turn.id,
      items.filter((item) => isCodexMessageItemType(item.type)).map((item) => item.id)
    )
    for (const item of items) {
      if (item.type === CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE) {
        queue.push(...readReceiverThreadIds(item))
      }
    }
  }
}
