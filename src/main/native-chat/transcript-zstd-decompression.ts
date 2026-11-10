import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { createZstdDecompress } from 'node:zlib'

export function isZstdTranscriptPath(path: string): boolean {
  return path.endsWith('.zst')
}

/** Pipes raw compressed bytes through the zstd decoder; errors on the raw stream surface on the output. */
export function zstdTranscriptStream(raw: Readable, encoding?: BufferEncoding): Readable {
  const decoder = createZstdDecompress()
  raw.on('error', (error) => decoder.destroy(error))
  const decoded = raw.pipe(decoder)
  if (!encoding) {
    return decoded
  }
  // Decode across chunk boundaries to avoid replacement characters on split codepoints.
  const stringDecoder = new StringDecoder(encoding)
  return Readable.from(
    (async function* (): AsyncGenerator<Buffer | string> {
      for await (const chunk of decoded) {
        const text = stringDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        if (text) {
          yield text
        }
      }
      const trailing = stringDecoder.end()
      if (trailing) {
        yield trailing
      }
    })()
  )
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
