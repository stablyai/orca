import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import { finishTranscriptWork, type TranscriptWork } from '../../transcript-work-scheduler'

/** Keep newest whole items within budget, retaining at least the latest item. */
export function createNewestItemWindow(maxBytes: number) {
  const entries = new Map<string, { item: JournalReplacementItem; bytes: number }>()
  let bytes = 0,
    reserved = 0,
    sequence = 0
  function* trimWork(): TranscriptWork<void> {
    while (bytes + reserved > maxBytes && entries.size > 1) {
      const [key, entry] = entries.entries().next().value!
      bytes -= entry.bytes
      entries.delete(key)
      yield 1
    }
  }
  function* storeWork(
    key: string,
    item: JournalReplacementItem,
    itemBytes: number
  ): TranscriptWork<void> {
    bytes -= entries.get(key)?.bytes ?? 0
    entries.delete(key)
    entries.set(key, { item, bytes: itemBytes })
    bytes += itemBytes
    yield* trimWork()
  }
  function* pushWork(item: JournalReplacementItem, itemBytes: number): TranscriptWork<void> {
    yield* storeWork(`#${sequence++}`, item, itemBytes)
  }
  function* upsertWork(
    key: string,
    item: JournalReplacementItem,
    itemBytes: number,
    extraBytes = 0
  ): TranscriptWork<void> {
    yield* storeWork(key, item, itemBytes + Buffer.byteLength(key) + extraBytes)
  }
  function* reserveWork(value: number): TranscriptWork<void> {
    reserved = value
    yield* trimWork()
  }
  function* itemsWork(): TranscriptWork<JournalReplacementItem[]> {
    const items: JournalReplacementItem[] = []
    for (const entry of entries.values()) {
      items.push(entry.item)
      yield 1
    }
    return items
  }
  return {
    push: (item: JournalReplacementItem, itemBytes = Buffer.byteLength(JSON.stringify(item))) =>
      finishTranscriptWork(pushWork(item, itemBytes)),
    pushWork,
    upsert: (key: string, item: JournalReplacementItem, extraBytes = 0) =>
      finishTranscriptWork(
        upsertWork(key, item, Buffer.byteLength(JSON.stringify(item)), extraBytes)
      ),
    upsertWork,
    get: (key: string) => entries.get(key)?.item,
    reserve: (value: number) => finishTranscriptWork(reserveWork(value)),
    reserveWork,
    items: () => finishTranscriptWork(itemsWork()),
    itemsWork
  }
}
