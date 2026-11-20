import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isTextBlock } from '../../../shared/native-chat/native-chat-types'

const REPLY_TEXT_MAX = 4000

/** Map a provider turn id to assistant text through the journal's turn item scope. */
export function assistantTextForTurn(items: AgentJournalRenderItem[], turnId: string): string {
  const turnItemIds = new Set(
    items
      .filter((item) => item.body.kind === 'turn' && item.body.turnId === turnId)
      .map((item) => item.itemId)
  )
  const assistantItems = items.filter((item) => {
    if (item.body.kind !== 'message' || item.body.role !== 'assistant') {
      return false
    }
    if (item.turnScope?.kind !== 'turn') {
      return false
    }
    return turnItemIds.size
      ? turnItemIds.has(item.turnScope.turnItemId)
      : item.turnScope.turnItemId === turnId
  })
  const last = assistantItems.at(-1)
  if (!last || last.body.kind !== 'message') {
    return ''
  }
  return last.body.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n')
    .trim()
    .slice(0, REPLY_TEXT_MAX)
}
