import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { readZstdTranscriptSlice, zstdTranscriptStream } from './transcript-zstd-decompression'

describe('zstdTranscriptStream', () => {
  it('closes the raw stream when the decoded stream stops before EOF', async () => {
    const compressed = zstdCompressSync(randomBytes(1024 * 1024))
    async function* rawChunks(): AsyncGenerator<Buffer> {
      for (let offset = 0; offset < compressed.length; offset += 16 * 1024) {
        yield compressed.subarray(offset, offset + 16 * 1024)
      }
    }
    const raw = Readable.from(rawChunks())
    const decoded = zstdTranscriptStream(raw)

    const head = await readZstdTranscriptSlice(decoded, 64 * 1024)

    expect(head.length).toBe(64 * 1024)
    await new Promise((resolve) => setImmediate(resolve))
    expect(raw.destroyed).toBe(true)
  })
})
