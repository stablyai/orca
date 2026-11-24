import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'

/** Keep newest whole items within budget, retaining at least the latest item. */
export function createNewestItemWindow(maxBytes: number) {
  const entries = new Map<string, { item: JournalReplacementItem; bytes: number }>()
  let bytes = 0,
    reserved = 0,
    sequence = 0
  const trim = () => {
    while (bytes + reserved > maxBytes && entries.size > 1) {
      const [key, entry] = entries.entries().next().value!
      bytes -= entry.bytes
      entries.delete(key)
    }
  }
  const store = (key: string, item: JournalReplacementItem, extraBytes = 0) => {
    bytes -= entries.get(key)?.bytes ?? 0
    entries.delete(key)
    const itemBytes = Buffer.byteLength(JSON.stringify(item)) + extraBytes
    entries.set(key, { item, bytes: itemBytes })
    bytes += itemBytes
    trim()
  }
  return {
    push: (item: JournalReplacementItem) => store(`#${sequence++}`, item),
    upsert: (key: string, item: JournalReplacementItem, extraBytes = 0) =>
      store(key, item, Buffer.byteLength(key) + extraBytes),
    get: (key: string) => entries.get(key)?.item,
    reserve: (value: number) => {
      reserved = value
      trim()
    },
    retainedBytes: () => bytes + entries.size + 2,
    items: () => [...entries.values()].map(({ item }) => item)
  }
}

/** The same suffix as createNewestItemWindow, offered newest first so callers stop once full. */
export function createNewestFirstItemWindow(maxBytes: number) {
  const newestFirst: JournalReplacementItem[] = []
  let bytes = 0
  return {
    /** False once the item no longer fits; nothing older can be retained. */
    offer(item: JournalReplacementItem): boolean {
      const itemBytes = Buffer.byteLength(JSON.stringify(item))
      if (newestFirst.length && bytes + itemBytes > maxBytes) {
        return false
      }
      newestFirst.push(item)
      bytes += itemBytes
      return true
    },
    retainedBytes: () => bytes + newestFirst.length + 2,
    items: () => newestFirst.toReversed()
  }
}
