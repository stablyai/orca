import { open, readFile, stat } from 'fs/promises'
import { extname } from 'path'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { STREAM_CHUNK_SIZE, RelayErrorCode } from './protocol'
import type { RelayStreamRegistry, TooManyStreamsError } from './fs-stream-registry'
import {
  BINARY_PROBE_BYTES,
  IMAGE_MIME_TYPES,
  MAX_PREVIEWABLE_BINARY_SIZE,
  MAX_TEXT_FILE_SIZE,
  isBinaryBuffer,
  isBinaryFilePrefix
} from './fs-handler-utils'

export async function readRelayFileContent(filePath: string) {
  const stats = await stat(filePath)
  const mimeType = IMAGE_MIME_TYPES[extname(filePath).toLowerCase()]
  const sizeLimit = mimeType ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_TEXT_FILE_SIZE
  if (stats.size > sizeLimit) {
    throw new Error(
      `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${sizeLimit / 1024 / 1024}MB limit`
    )
  }

  if (mimeType) {
    const buffer = await readFile(filePath)
    return { content: buffer.toString('base64'), isBinary: true, isImage: true, mimeType }
  }

  if (stats.size > BINARY_PROBE_BYTES && (await isBinaryFilePrefix(filePath))) {
    return { content: '', isBinary: true }
  }

  const buffer = await readFile(filePath)
  if (isBinaryBuffer(buffer)) {
    return { content: '', isBinary: true }
  }
  return { content: buffer.toString('utf-8'), isBinary: false }
}

export type StreamMetadata = {
  streamId?: number
  totalSize: number
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  /** On-the-wire encoding of each chunk's `data` field. Always 'base64'. */
  chunkEncoding?: 'base64'
  /** Encoding of the assembled FileReadResult.content. */
  resultEncoding?: 'base64' | 'utf-8'
  /** True for empty files and binary archives that short-circuit without pumping. */
  empty?: boolean
}

export async function readRelayFileStreamMetadata(
  filePath: string,
  dispatcher: RelayDispatcher,
  registry: RelayStreamRegistry,
  context: RequestContext
): Promise<StreamMetadata> {
  const stats = await stat(filePath)
  const mimeType = IMAGE_MIME_TYPES[extname(filePath).toLowerCase()]
  const sizeLimit = mimeType ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_TEXT_FILE_SIZE
  if (stats.size > sizeLimit) {
    throw new Error(
      `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${sizeLimit / 1024 / 1024}MB limit`
    )
  }

  if (stats.size === 0) {
    return {
      totalSize: 0,
      isBinary: !!mimeType,
      mimeType,
      isImage: mimeType ? true : undefined,
      empty: true
    }
  }
  // Why: unlike the legacy single-shot path, streaming does not read the full
  // buffer before classifying content. Probe every unknown file so small binary
  // files do not get decoded as UTF-8 text over SSH.
  if (!mimeType && (await isBinaryFilePrefix(filePath))) {
    return { totalSize: 0, isBinary: true, empty: true }
  }

  const handle = await open(filePath, 'r')
  let streamId: number
  try {
    streamId = registry.register(handle)
  } catch (err) {
    await handle.close()
    throw err
  }

  process.stderr.write(`[relay] stream start id=${streamId} size=${stats.size}\n`)

  // Why: pumpChunks owns its own try/finally for handle release; the outer
  // setImmediate kicks the pump off the metadata-response task so the client
  // sees the response before the first chunk frame.
  setImmediate(() => {
    void pumpChunks(streamId, stats.size, dispatcher, registry, context)
  })

  return {
    streamId,
    totalSize: stats.size,
    isBinary: !!mimeType,
    isImage: mimeType ? true : undefined,
    mimeType,
    chunkEncoding: 'base64',
    resultEncoding: mimeType ? 'base64' : 'utf-8'
  }
}

async function pumpChunks(
  streamId: number,
  totalSize: number,
  dispatcher: RelayDispatcher,
  registry: RelayStreamRegistry,
  context: RequestContext
): Promise<void> {
  const entry = registry.get(streamId)
  if (!entry) {
    return
  }
  const buffer = Buffer.allocUnsafe(STREAM_CHUNK_SIZE)
  let offset = 0
  let seq = 0
  let endReason: 'end' | 'aborted' | 'stale' | 'error' = 'end'
  let errorCode: string | null = null
  let errorMessage: string | null = null

  try {
    try {
      while (offset < totalSize) {
        if (context.isStale()) {
          endReason = 'stale'
          break
        }
        if (registry.isAborted(streamId)) {
          endReason = 'aborted'
          break
        }
        const want = Math.min(STREAM_CHUNK_SIZE, totalSize - offset)
        const { bytesRead } = await entry.handle.read(buffer, 0, want, offset)
        if (bytesRead === 0) {
          endReason = 'error'
          errorCode = 'ESTREAMTRUNCATED'
          errorMessage = `File truncated mid-stream: expected ${totalSize}, got ${offset}`
          break
        }
        if (context.isStale()) {
          endReason = 'stale'
          break
        }
        if (registry.isAborted(streamId)) {
          endReason = 'aborted'
          break
        }
        const data = buffer.subarray(0, bytesRead).toString('base64')
        dispatcher.notify('fs.streamChunk', { streamId, seq, data })
        offset += bytesRead
        seq += 1
      }
    } catch (err) {
      // Why: a read() rejection that races with disposeAll surfaces as EBADF;
      // treat as aborted so we don't emit a spurious streamError to a client
      // that is already gone.
      const code = (err as { code?: string }).code
      if (code === 'EBADF' && registry.isAborted(streamId)) {
        endReason = 'aborted'
      } else {
        endReason = 'error'
        errorCode = code ?? 'ESTREAMREAD'
        errorMessage = err instanceof Error ? err.message : String(err)
      }
    }

    try {
      if (endReason === 'end') {
        dispatcher.notify('fs.streamEnd', { streamId })
        process.stderr.write(`[relay] stream end id=${streamId}\n`)
      } else if (endReason === 'error') {
        dispatcher.notify('fs.streamError', {
          streamId,
          code: errorCode ?? 'ESTREAMERROR',
          message: errorMessage ?? 'stream error'
        })
        process.stderr.write(`[relay] stream error id=${streamId} code=${errorCode}\n`)
      } else if (endReason === 'aborted') {
        process.stderr.write(`[relay] stream cancel id=${streamId}\n`)
      } else {
        process.stderr.write(`[relay] stream stale id=${streamId}\n`)
      }
    } catch (err) {
      process.stderr.write(
        `[relay] stream notify failed id=${streamId}: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
  } finally {
    await registry.release(streamId)
  }
}

export function isTooManyStreamsError(err: unknown): err is TooManyStreamsError {
  return err instanceof Error && (err as { code?: number }).code === RelayErrorCode.TooManyStreams
}
