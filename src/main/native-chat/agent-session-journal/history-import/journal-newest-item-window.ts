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
    items: () => [...entries.values()].map(({ item }) => item)
  }
}
