import type { Readable } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import { openTranscriptReadStream } from '../../../native-chat/wsl-transcript-fs-access'

export function openCodexRolloutReadStream(path: string): Readable {
  if (!path.endsWith('.jsonl.zst')) {
    return openTranscriptReadStream(path, { encoding: 'utf-8' }, 'scan')
  }
  const compressed = openTranscriptReadStream(path, {}, 'scan')
  const decoder = createZstdDecompress()
  compressed.on('error', (error) => decoder.destroy(error))
  return compressed.pipe(decoder)
}

// Offsets are decoded JSONL bytes. `start` skips that many bytes after decompression.
export async function* readDecompressedCodexRollout(
  path: string,
  start: number,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  const compressed = openTranscriptReadStream(path, {}, 'scan', signal)
  const decoder = createZstdDecompress()
  compressed.on('error', (error) => decoder.destroy(error))
  compressed.pipe(decoder)
  let skip = start
  try {
    for await (const chunk of decoder) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (skip <= 0) {
        yield buffer
        continue
      }
      if (buffer.length <= skip) {
        skip -= buffer.length
        continue
      }
      yield buffer.subarray(skip)
      skip = 0
    }
  } finally {
    decoder.destroy()
    compressed.destroy()
  }
}
