import { open } from 'node:fs/promises'
import type { Readable } from 'node:stream'

const NEWLINE = 0x0a
const SEARCH_CHUNK_BYTES = 64 * 1024

/** Finds the first complete JSONL record inside the newest byte window. */
export async function newlineAlignedTailStart(
  filePath: string,
  end: number,
  maxBytes: number
): Promise<number> {
  const lowerBound = Math.max(0, end - maxBytes)
  if (lowerBound === 0) {
    return 0
  }
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(Math.min(SEARCH_CHUNK_BYTES, end - lowerBound))
    let position = lowerBound
    while (position < end) {
      const length = Math.min(buffer.length, end - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead === 0) {
        return end
      }
      const newline = buffer.subarray(0, bytesRead).indexOf(NEWLINE)
      if (newline !== -1) {
        return position + newline + 1
      }
      position += bytesRead
    }
    return end
  } finally {
    await handle.close()
  }
}

/** Retains a bounded decoded suffix while a compressed rollout is streamed. */
export async function readStreamTail(
  stream: Readable,
  maxBytes: number
): Promise<{ bytes: Buffer; decodedStart: number }> {
  const tail = Buffer.allocUnsafe(maxBytes)
  let retained = 0
  let decodedBytes = 0

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    decodedBytes += chunk.length
    if (chunk.length >= maxBytes) {
      chunk.copy(tail, 0, chunk.length - maxBytes)
      retained = maxBytes
      continue
    }
    const overflow = Math.max(0, retained + chunk.length - maxBytes)
    if (overflow > 0) {
      tail.copyWithin(0, overflow, retained)
      retained -= overflow
    }
    chunk.copy(tail, retained)
    retained += chunk.length
  }

  let bytes = tail.subarray(0, retained)
  let decodedStart = decodedBytes - retained
  if (decodedStart > 0) {
    const newline = bytes.indexOf(NEWLINE)
    if (newline === -1) {
      return { bytes: Buffer.alloc(0), decodedStart: decodedBytes }
    }
    bytes = bytes.subarray(newline + 1)
    decodedStart += newline + 1
  }
  return { bytes, decodedStart }
}
