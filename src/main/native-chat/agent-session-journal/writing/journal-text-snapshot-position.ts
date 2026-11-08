import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'

/** The stream retains placement, never a second copy of its saved text. */
export type JournalTextSnapshotPosition = Omit<AgentJournalRenderItem, 'body'>

export function journalTextSnapshotPosition(
  item: AgentJournalRenderItem
): JournalTextSnapshotPosition | undefined {
  if (
    item.body.kind !== 'message' ||
    (item.body.role !== 'assistant' && item.body.role !== 'reasoning') ||
    item.body.blocks.some((block) => block.type !== 'text')
  ) {
    return undefined
  }
  const { body: _body, ...position } = item
  return position
}
