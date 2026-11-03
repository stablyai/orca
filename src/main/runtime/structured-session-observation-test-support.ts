import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session/agent-session-wire'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

export function leaseOf(sessionId: string) {
  const record = getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)
  if (!record) {
    throw new Error(`Missing structured session record: ${sessionId}`)
  }
  return record.lease
}

export function itemsOf(frames: AgentSessionSubscribeEvent[]): AgentJournalRenderItem[] {
  const items = new Map<string, AgentJournalRenderItem>()
  for (const frame of frames) {
    const rows =
      frame.type === 'snapshot' || frame.type === 'reset'
        ? frame.page.items
        : frame.type === 'batch'
          ? frame.batch.items
          : []
    for (const row of rows) {
      items.set(row.itemId, row)
    }
  }
  return [...items.values()]
}

export function textOf(item: AgentJournalRenderItem): string {
  return item.body?.kind === 'message'
    ? item.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    : ''
}
