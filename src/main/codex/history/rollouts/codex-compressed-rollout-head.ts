import { addAbortSignal, Readable } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import { readTranscriptSlice } from '../../../native-chat/wsl-transcript-fs-access'
import type { WslTranscriptFsTaskPriority } from '../../../native-chat/wsl-transcript-fs-gate'

const COMPRESSED_CHUNK_BYTES = 64 * 1024
const COMPRESSED_HEAD_LIMIT = 4 * COMPRESSED_CHUNK_BYTES

export async function readCodexCompressedRolloutHead(
  filePath: string,
  limit: number,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<Buffer> {
  const input = Readable.from(compressedChunks(filePath, priority, signal), {
    objectMode: false,
    highWaterMark: COMPRESSED_CHUNK_BYTES
  })
  const decoder = createZstdDecompress({ chunkSize: limit })
  if (signal) {
    addAbortSignal(signal, decoder)
  }
  input.on('error', (error: Error) => decoder.destroy(error))
  const output = input.pipe(decoder)
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of output) {
      if (!Buffer.isBuffer(chunk)) {
        throw new Error('Invalid compressed Codex rollout chunk')
      }
      const prefix = chunk.subarray(0, limit - bytes)
      const newline = prefix.indexOf(10)
      const head = newline === -1 ? prefix : prefix.subarray(0, newline + 1)
      chunks.push(head)
      bytes += head.length
      if (newline !== -1 || bytes === limit) {
        break
      }
    }
    return Buffer.concat(chunks, bytes)
  } finally {
    input.destroy()
    output.destroy()
  }
}

async function* compressedChunks(
  filePath: string,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < COMPRESSED_HEAD_LIMIT; offset += COMPRESSED_CHUNK_BYTES) {
    signal?.throwIfAborted()
    const chunk = await readTranscriptSlice(
      filePath,
      offset,
      COMPRESSED_CHUNK_BYTES,
      priority,
      signal
    )
    if (chunk.length === 0) {
      return
    }
    yield chunk
  }
  throw new Error('Compressed Codex session metadata exceeds the read limit')
}
