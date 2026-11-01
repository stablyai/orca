import { open } from 'node:fs/promises'
import { z } from 'zod'

const BLOCK_BYTES = 64 * 1024
// Bound tail scanning to the peer's maximum accepted reply size.
const MAX_TAIL_BYTES = 8 * 1024 * 1024

/** File-tail ID only hints where to query; Pi's loaded-tree answer remains authoritative. */
export async function readPiSessionLastEntryId(file: string): Promise<string | null> {
  const handle = await open(file, 'r')
  try {
    let position = (await handle.stat()).size
    // Reassemble the newest partial line in file order.
    let partial: Buffer[] = []
    let partialBytes = 0
    // A last line without its newline is still being appended; it is not an entry yet.
    let complete = false
    while (position > 0 && partialBytes <= MAX_TAIL_BYTES) {
      const length = Math.min(BLOCK_BYTES, position)
      position -= length
      const block = Buffer.alloc(length)
      await handle.read(block, 0, length, position)
      let end = length
      for (let index = length - 1; index >= 0; index--) {
        if (block[index] !== 0x0a) {
          continue
        }
        const id = complete ? entryId([block.subarray(index + 1, end), ...partial]) : null
        if (id !== null) {
          return id
        }
        complete = true
        partial = []
        partialBytes = 0
        end = index
      }
      partial.unshift(block.subarray(0, end))
      partialBytes += end
    }
    return position === 0 && complete ? entryId(partial) : null
  } finally {
    await handle.close()
  }
}

const entryHeadSchema = z.looseObject({ type: z.unknown(), id: z.string().min(1) })

function entryId(parts: Buffer[]): string | null {
  let record: unknown
  try {
    record = JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch {
    return null
  }
  const head = entryHeadSchema.safeParse(record)
  return head.success && head.data.type !== 'session' ? head.data.id : null
}
