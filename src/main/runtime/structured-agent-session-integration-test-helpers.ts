import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'

/** Every item the subscription has published, latest revision per id. */
export function itemsOf(frames: AgentSessionSubscribeEvent[]): AgentJournalRenderItem[] {
  const items = new Map<string, AgentJournalRenderItem>()
  for (const frame of frames) {
    const published =
      frame.type === 'snapshot' || frame.type === 'reset'
        ? frame.snapshot.items
        : frame.type === 'batch'
          ? frame.batch.items
          : []
    for (const item of published) {
      items.set(item.itemId, item)
    }
  }
  return [...items.values()]
}

export function cursorOf(frames: AgentSessionSubscribeEvent[]): {
  epoch: string
  sequence: number
} {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index] as AgentSessionSubscribeEvent
    if (frame.type === 'batch') {
      return frame.batch.cursor
    }
    if (frame.type === 'snapshot' || frame.type === 'reset') {
      return frame.snapshot.cursor
    }
  }
  throw new Error('subscription published no cursor')
}
