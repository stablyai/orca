import { decompressSessionZstdFrames } from './session-zstd-frames'

const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_SOURCE_BYTES = 64 * 1024 * 1024
const MAX_DECODED_BYTES = 64 * 1024 * 1024

// Reasonix 1.39.7 RX4F wraps each independent Zstandard record in a big-endian header.
export async function* reasonixFrameRecords(
  bytes: AsyncIterable<Buffer>,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  const iterator = bytes[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0)
  let ended = false
  let sourceBytes = 0
  let decodedBytes = 0
  async function take(count: number): Promise<Buffer> {
    const parts: Buffer[] = []
    let size = 0
    while (size < count) {
      signal?.throwIfAborted()
      if (!pending.length && !ended) {
        const next = await iterator.next()
        ended = next.done === true
        pending = next.value ?? Buffer.alloc(0)
      }
      if (ended && !pending.length) {
        break
      }
      const length = Math.min(count - size, pending.length)
      parts.push(pending.subarray(0, length))
      pending = pending.subarray(length)
      size += length
      sourceBytes += length
      if (sourceBytes > MAX_SOURCE_BYTES) {
        throw new Error('Reasonix history exceeds read budget')
      }
    }
    return Buffer.concat(parts, size)
  }
  try {
    for (;;) {
      const header = await take(12)
      // Native readers ignore an incomplete appended frame until the writer finishes it.
      if (header.length < 12) {
        return
      }
      if (header.readUInt32BE(0) !== 0x52583446) {
        throw new Error('Invalid Reasonix frame magic')
      }
      const compressedLength = header.readUInt32BE(4)
      const rawLength = header.readUInt32BE(8)
      if (
        compressedLength === 0 ||
        compressedLength > MAX_FRAME_BYTES ||
        rawLength === 0 ||
        rawLength > MAX_FRAME_BYTES
      ) {
        throw new Error('Invalid Reasonix frame sizes')
      }
      const compressed = await take(compressedLength)
      if (compressed.length < compressedLength) {
        return
      }
      async function* frame(): AsyncGenerator<Buffer> {
        yield compressed
      }
      const parts: Buffer[] = []
      let size = 0
      for await (const chunk of decompressSessionZstdFrames(frame(), {
        provider: 'Reasonix',
        compressedBytes: MAX_FRAME_BYTES,
        decodedBytes: rawLength,
        windowLogMax: 23
      })) {
        signal?.throwIfAborted()
        decodedBytes += chunk.length
        if (decodedBytes > MAX_DECODED_BYTES) {
          throw new Error('Reasonix decoded history exceeds read budget')
        }
        parts.push(chunk)
        size += chunk.length
      }
      if (size !== rawLength) {
        throw new Error('Reasonix frame decoded size mismatch')
      }
      yield Buffer.concat(parts, size)
    }
  } finally {
    await iterator.return?.()
  }
}
