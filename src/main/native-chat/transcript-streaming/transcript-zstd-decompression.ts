import { pipeline, type Readable } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'

export function isZstdTranscriptPath(path: string): boolean {
  return path.endsWith('.zst')
}

/** Pipes raw compressed bytes through the zstd decoder; errors on the raw stream surface on the output. */
export function zstdTranscriptStream(raw: Readable): Readable {
  const decoder = createZstdDecompress()
  // pipeline links lifetimes so an early close of the decoded stream releases the raw stream's fd.
  pipeline(raw, decoder, () => undefined)
  return decoder
}

/** Collects at most `length` decompressed bytes; compressed transcripts are small enough to keep in memory. */
export async function readZstdTranscriptSlice(stream: Readable, length: number): Promise<Buffer> {
  const parts: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    parts.push(buffer)
    total += buffer.length
    if (total >= length) {
      break
    }
  }
  return Buffer.concat(parts).subarray(0, Math.min(total, length))
}
