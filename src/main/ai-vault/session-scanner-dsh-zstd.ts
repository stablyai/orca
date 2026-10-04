import { Readable } from 'node:stream'
import * as zlib from 'node:zlib'

const MAX_FRAME_BYTES = 32 * 1024 * 1024

// Node's stream stops at the first frame; DSH appends independently checksummed frames.
export async function* decompressDshFrames(bytes: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  if (typeof zlib.createZstdDecompress !== 'function') {
    throw new Error(
      'DSH compressed history requires a host Node runtime with Zstandard support (22.15 or newer).'
    )
  }
  const iterator = bytes[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0)
  let ended = false
  async function take(count: number, allowEnd = false): Promise<Buffer> {
    const parts: Buffer[] = []
    let size = 0
    while (size < count) {
      if (!pending.length && !ended) {
        const next = await iterator.next()
        ended = next.done === true
        pending = next.value ?? Buffer.alloc(0)
      }
      if (ended && !pending.length) {
        if (allowEnd && size === 0) {
          return Buffer.alloc(0)
        }
        throw new Error('Truncated DSH Zstandard frame')
      }
      const length = Math.min(count - size, pending.length)
      parts.push(pending.subarray(0, length))
      pending = pending.subarray(length)
      size += length
    }
    return Buffer.concat(parts, count)
  }
  try {
    for (;;) {
      const magic = await take(4, true)
      if (!magic.length) {
        return
      }
      if (magic.readUInt32LE(0) !== 0xfd2fb528) {
        throw new Error('Invalid DSH Zstandard frame magic')
      }
      const descriptor = await take(1)
      const flag = descriptor[0]
      if ((flag & 0x18) !== 0) {
        throw new Error('Invalid DSH Zstandard frame header')
      }
      const single = (flag & 0x20) !== 0
      const dictionary = flag & 3
      const content = flag >>> 6
      const headerSize =
        (single ? 0 : 1) +
        (dictionary === 3 ? 4 : dictionary) +
        (content === 0 ? (single ? 1 : 0) : 1 << content)
      const parts = [magic, descriptor, await take(headerSize)]
      let size = 5 + headerSize
      for (;;) {
        const header = await take(3)
        const block = header.readUIntLE(0, 3)
        const kind = (block >>> 1) & 3
        if (kind === 3) {
          throw new Error('Invalid DSH Zstandard block')
        }
        const length = kind === 1 ? 1 : block >>> 3
        size += 3 + length
        if (size > MAX_FRAME_BYTES) {
          throw new Error('DSH compressed frame exceeds history read budget')
        }
        parts.push(header, await take(length))
        if (block & 1) {
          break
        }
      }
      if (flag & 4) {
        parts.push(await take(4))
      }
      const source = Readable.from(parts)
      const decoder = zlib.createZstdDecompress({
        params: { [zlib.constants.ZSTD_d_windowLogMax]: 26 }
      })
      source.on('error', (error) => decoder.destroy(error))
      let decodedBytes = 0
      try {
        for await (const chunk of source.pipe(decoder)) {
          if (!Buffer.isBuffer(chunk)) {
            throw new Error('Invalid DSH decoder output')
          }
          decodedBytes += chunk.length
          if (decodedBytes > MAX_FRAME_BYTES * 2) {
            throw new Error('DSH decoded frame exceeds history read budget')
          }
          yield chunk
        }
      } finally {
        source.destroy()
        decoder.destroy()
      }
    }
  } finally {
    await iterator.return?.()
  }
}
