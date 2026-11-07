import { createReadStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'

/** Bookmarks count decoded JSONL bytes, including newlines, never compressed file bytes. */
export async function* readCodexRolloutBytes(
  path: string,
  end?: number,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  throwIfSignalAborted(signal)
  const decoder = path.endsWith('.zst') ? createZstdDecompress() : undefined
  const file = createReadStream(path, { signal })
  try {
    if (decoder) {
      file.on('error', (error) => decoder.destroy(error))
      file.pipe(decoder)
    }
    let remaining = end ?? Infinity
    for await (const chunk of decoder ?? file) {
      throwIfSignalAborted(signal)
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const prefix = buffer.subarray(0, Math.min(buffer.length, remaining))
      if (prefix.length) {
        yield prefix
      }
      remaining -= prefix.length
      if (remaining === 0) {
        break
      }
    }
  } catch (error) {
    throwIfSignalAborted(signal)
    throw error
  } finally {
    decoder?.destroy()
    file.destroy()
    await Promise.allSettled([
      finished(file, { cleanup: true }),
      ...(decoder ? [finished(decoder, { cleanup: true })] : [])
    ])
  }
}
