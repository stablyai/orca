import { createReadStream } from 'node:fs'
import { addAbortSignal } from 'node:stream'
import { finished } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'

/** Bookmarks count decoded JSONL bytes, including newlines, never compressed file bytes. */
export async function* readCodexRolloutBytes(
  path: string,
  end?: number,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  signal?.throwIfAborted()
  const decoder = path.endsWith('.zst') ? createZstdDecompress() : undefined
  const file = createReadStream(path, { signal })
  try {
    if (decoder) {
      file.on('error', (error) => decoder.destroy(error))
      if (signal) {
        addAbortSignal(signal, decoder)
      }
      file.pipe(decoder)
    }
    let remaining = end ?? Infinity
    for await (const chunk of decoder ?? file) {
      signal?.throwIfAborted()
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const prefix = buffer.subarray(0, Math.min(buffer.length, remaining))
      if (prefix.length) {
        yield prefix
        signal?.throwIfAborted()
      }
      remaining -= prefix.length
      if (remaining === 0) {
        break
      }
    }
  } finally {
    decoder?.destroy()
    file.destroy()
    await Promise.allSettled([
      finished(file, { cleanup: true }),
      ...(decoder ? [finished(decoder, { cleanup: true })] : [])
    ])
  }
}
