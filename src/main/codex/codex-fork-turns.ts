import { asRecord } from '../ai-vault/parsing/session-record-fields'
import type { CodexAppServerRpc } from './app-server/codex-app-server-session'
import { AgentConversationCopyError } from '../native-chat/conversation-adoption/agent-conversation-copy-error'

export async function readCodexForkTurns(
  rpc: CodexAppServerRpc,
  threadId: string,
  through: number | string
): Promise<{ id: string; status?: unknown }[]> {
  const all: { id: string; status?: unknown }[] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  do {
    const page = asRecord(
      await rpc.request('thread/turns/list', {
        threadId,
        cursor,
        sortDirection: 'asc',
        limit: 100,
        itemsView: 'summary'
      })
    )
    if (!Array.isArray(page?.data)) {
      throw new AgentConversationCopyError('Codex could not verify the copied chat.')
    }
    for (const raw of page.data) {
      const turn = asRecord(raw)
      if (typeof turn?.id !== 'string') {
        throw new AgentConversationCopyError('Codex could not verify the copied chat.')
      }
      all.push({ id: turn.id, status: turn.status })
      if (turn.id === through) {
        return all
      }
    }
    if (page.nextCursor != null && (typeof page.nextCursor !== 'string' || !page.nextCursor)) {
      throw new AgentConversationCopyError('Codex could not verify the copied chat.')
    }
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null
    if (cursor && seen.has(cursor)) {
      throw new AgentConversationCopyError('Codex could not verify the copied chat.')
    }
    if (cursor) {
      seen.add(cursor)
    }
  } while (cursor && (typeof through === 'string' || all.length < through))
  return all
}
