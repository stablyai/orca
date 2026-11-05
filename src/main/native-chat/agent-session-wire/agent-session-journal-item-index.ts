import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

// Public item arrays are immutable and replaced on journal/epoch changes.
const itemsByTimeline = new WeakMap<
  readonly AgentJournalRenderItem[],
  ReadonlyMap<string, AgentJournalRenderItem>
>()

export function journalItemsById(
  items: readonly AgentJournalRenderItem[]
): ReadonlyMap<string, AgentJournalRenderItem> {
  let indexed = itemsByTimeline.get(items)
  if (!indexed) {
    indexed = new Map(items.map((item) => [item.itemId, item]))
    itemsByTimeline.set(items, indexed)
  }
  return indexed
}

/** Public timelines sort by creation position; visit only the requested sequence group. */
export function journalItemsAtSequence(
  items: readonly AgentJournalRenderItem[],
  sequence: number
): AgentJournalRenderItem[] {
  let low = 0
  let high = items.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (items[middle].sequence < sequence) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  let end = low
  while (end < items.length && items[end].sequence === sequence) {
    end++
  }
  return items.slice(low, end)
}
