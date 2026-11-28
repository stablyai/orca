import { setImmediate as yieldIo } from 'node:timers/promises'
import type { RexFreshSession } from './rex-fresh-session'
import type { RexStreamParser } from './rex-stream-parser'

const CHUNK_BYTES = 16 * 1024
const TURN_BYTES = 64 * 1024

/** Bound the amount of parser work between I/O turns. A partially consumed frame
 * stays with this reader, so transport resume never duplicates or skips its tail.
 */
export async function consumeRexOutput(
  session: RexFreshSession,
  parser: RexStreamParser,
  tail: Buffer,
  continuation: Buffer | undefined,
  current: () => boolean
): Promise<void> {
  const stream = session.data
  let work = 0
  async function feed(bytes: Buffer): Promise<void> {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      await stream.waitForDelivery()
      if (!current()) {
        return
      }
      const part = bytes.subarray(offset, offset + CHUNK_BYTES)
      parser.feed(part)
      work += part.length
      if (work >= TURN_BYTES) {
        work = 0
        await yieldIo()
      }
    }
  }

  if (continuation) {
    await feed(continuation)
    continuation = undefined
  }
  await feed(tail)
  tail = Buffer.alloc(0)
  while (current()) {
    await feed(await stream.next())
  }
}
