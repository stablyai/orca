import type { JournalReplacementItem } from './journal-epoch-replacement'

/** The newest complete items that fit `maxBytes`; the latest item is always kept. */
export function createNewestItemWindow(maxBytes: number): {
  push(item: JournalReplacementItem): void
  items(): JournalReplacementItem[]
} {
  let entries: ({ item: JournalReplacementItem; bytes: number } | undefined)[] = []
  let head = 0
  let bytes = 0
  return {
    push(item) {
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8')
      entries.push({ item, bytes: itemBytes })
      bytes += itemBytes
      while (bytes > maxBytes && head < entries.length - 1) {
        bytes -= entries[head]?.bytes ?? 0
        entries[head] = undefined
        head += 1
      }
      // Drop evicted entries in batches so a long source stays linear.
      if (head > 1024 && head * 2 > entries.length) {
        entries = entries.slice(head)
        head = 0
      }
    },
    items: () => entries.slice(head).flatMap((entry) => (entry ? [entry.item] : []))
  }
}
