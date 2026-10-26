import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { isTextBlock } from '../../../shared/native-chat-types'

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

/** Whether the turn's user input was Orca's own send (a room prompt): user-composed
 *  turns carry no agent `from` and must never be lifted into a room. */
export function turnStartedByRoom(items: AgentJournalRenderItem[], turnId: string): boolean {
  const turnItemIds = new Set(
    items
      .filter((item) => item.body.kind === 'turn' && item.body.turnId === turnId)
      .map((item) => item.itemId)
  )
  return items.some((item) => {
    if (item.body.kind !== 'message' || item.body.role !== 'user') {
      return false
    }
    if (item.turnScope?.kind !== 'turn') {
      return false
    }
    if (turnItemIds.size ? !turnItemIds.has(item.turnScope.turnItemId) : item.turnScope.turnItemId !== turnId) {
      return false
    }
    return item.body.from?.kind === 'agent'
  })
}
