import type { JournalReplacementItem } from './journal-epoch-replacement'
import { finishTranscriptWork, type TranscriptWork } from '../transcript-work-scheduler'

/** Keep newest whole items within budget, retaining at least the latest item. */
export function createNewestItemWindow(maxBytes: number): {
  push(item: JournalReplacementItem, itemBytes?: number): void
  pushWork(item: JournalReplacementItem, itemBytes: number): TranscriptWork<void>
  items(): JournalReplacementItem[]
  itemsWork(): TranscriptWork<JournalReplacementItem[]>
} {
  let entries: ({ item: JournalReplacementItem; bytes: number } | undefined)[] = []
  let head = 0
  let bytes = 0
  return {
    push(item, itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8')) {
      finishTranscriptWork(pushWork(item, itemBytes))
    },
    pushWork,
    items: () => finishTranscriptWork(itemsWork()),
    itemsWork
  }

  function* pushWork(item: JournalReplacementItem, itemBytes: number): TranscriptWork<void> {
    entries.push({ item, bytes: itemBytes })
    bytes += itemBytes
    while (bytes > maxBytes && head < entries.length - 1) {
      bytes -= entries[head]?.bytes ?? 0
      entries[head] = undefined
      head += 1
      yield 1
    }
    // Charge compaction to the larger evicted prefix, keeping total work linear.
    if (head > 1024 && head * 2 > entries.length) {
      const compacted: typeof entries = []
      for (let index = head; index < entries.length; index++) {
        compacted.push(entries[index])
        yield 1
      }
      entries = compacted
      head = 0
    }
  }

  function* itemsWork(): TranscriptWork<JournalReplacementItem[]> {
    const items: JournalReplacementItem[] = []
    for (let index = head; index < entries.length; index++) {
      const entry = entries[index]
      if (entry) {
        items.push(entry.item)
      }
      yield 1
    }
    return items
  }
}
