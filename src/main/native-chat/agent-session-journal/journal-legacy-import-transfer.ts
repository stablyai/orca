import type { JournalReplacementItem } from './journal-epoch-replacement'
import type { LegacyImportWorkerMessage } from './journal-legacy-import-worker-protocol'

const TRANSFER_QUANTUM_BYTES = 64 * 1024
type ItemBatch = Extract<LegacyImportWorkerMessage, { type: 'items' }>

/** Pace original values, including a whole item larger than the ordinary scheduling quantum. */
export async function transferLegacyImportItems(
  items: JournalReplacementItem[],
  send: (batch: ItemBatch) => Promise<void>
): Promise<{ itemCount: number; batchCount: number }> {
  const itemCount = items.length
  let index = 0
  let first = 0
  let batch: ItemBatch = { type: 'items', index, items: [] }
  let bytes = Buffer.byteLength(JSON.stringify(batch))
  const flush = async (end: number) => {
    await send(batch)
    for (; first < end; first++) {
      delete items[first]
    }
    batch = { type: 'items', index: ++index, items: [] }
    bytes = Buffer.byteLength(JSON.stringify(batch))
  }
  for (let position = 0; position < itemCount; position++) {
    const item = items[position]
    const itemBytes = Buffer.byteLength(JSON.stringify(item))
    if (batch.items.length && bytes + 1 + itemBytes > TRANSFER_QUANTUM_BYTES) {
      await flush(position)
    }
    bytes += itemBytes + (batch.items.length ? 1 : 0)
    batch.items.push(item)
  }
  if (batch.items.length) {
    await flush(itemCount)
  }
  return { itemCount, batchCount: index }
}
