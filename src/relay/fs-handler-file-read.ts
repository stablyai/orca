import { open, readFile, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { STREAM_ACK_WINDOW_CHUNKS, STREAM_CHUNK_SIZE } from './protocol'
import type { RelayStreamRegistry } from './fs-stream-registry'
import { reserveTerminalFrameSlot } from './fs-stream-terminal-frame-slots'
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

type StreamChunkReader = {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>
}

export type StreamPumpOptions = {
  /** Client that requested the stream. Chunks go only to it — broadcasting
   * bulk frames would let one slow secondary client stall the requester. */
  clientId?: number
  /** True when the client declared `flowControl: 'ack'` — it sends
   * fs.streamAck per processed chunk and the pump caps unacked chunks. */
  paceWithAcks: boolean
}

export async function readRelayFileStreamMetadata(
  filePath: string,
  dispatcher: RelayDispatcher,
  registry: RelayStreamRegistry,
  context: RequestContext,
  pumpOptions?: StreamPumpOptions
): Promise<StreamMetadata> {
  const finish = registry.beginOperation()
  try {
    return await prepareRelayFileStream(filePath, dispatcher, registry, context, pumpOptions)
  } finally {
    finish()
  }
}

async function prepareRelayFileStream(
  filePath: string,
  dispatcher: RelayDispatcher,
  registry: RelayStreamRegistry,
  context: RequestContext,
  pumpOptions?: StreamPumpOptions
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
  if (
    !mimeType &&
    (await isBinaryFilePrefix(filePath, (handle) => registry.releaseUnregisteredHandle(handle)))
  ) {
    return { totalSize: 0, isBinary: true, empty: true }
  }

  // Why: reserved before the fd opens so a refusal costs nothing, and released only
  // once the terminal frame settles — see reserveTerminalFrameSlot.
  const releaseTerminalFrameSlot = reserveTerminalFrameSlot(registry, context.clientId)
  let handle: FileHandle | undefined
  let streamId: number
  try {
    handle = await open(filePath, 'r')
    streamId = registry.register(handle)
  } catch (err) {
    try {
      if (handle) {
        await registry.releaseUnregisteredHandle(handle)
      }
    } finally {
      releaseTerminalFrameSlot()
    }
    throw err
  }

  process.stderr.write(`[relay] stream start id=${streamId} size=${stats.size}\n`)

  // Why: pumpChunks owns its own try/finally for handle release; the outer
  // setImmediate kicks the pump off the metadata-response task so the client
  // sees the response before the first chunk frame.
  const resolvedPumpOptions = pumpOptions ?? { paceWithAcks: false }
  const finishPump = registry.beginOperation()
  setImmediate(() => {
    void pumpChunks(
      streamId,
      stats.size,
      dispatcher,
      registry,
      context,
      resolvedPumpOptions,
      releaseTerminalFrameSlot
    )
      .catch((error: unknown) => {
        process.stderr.write(`[relay] stream cleanup failed id=${streamId}: ${String(error)}\n`)
      })
      .finally(finishPump)
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
  context: RequestContext,
  pumpOptions: StreamPumpOptions,
  releaseTerminalFrameSlot: () => void
): Promise<void> {
  const entry = registry.get(streamId)
  if (!entry) {
    releaseTerminalFrameSlot()
    return
  }
  const buffer = Buffer.allocUnsafe(STREAM_CHUNK_SIZE)
  let offset = 0
  let seq = 0
  let endReason: 'end' | 'aborted' | 'stale' | 'error' = 'end'
  let errorCode: string | null = null
  let errorMessage: string | null = null
  let slotReleaseDeferred = false

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
        // Why: credit window — bulk chunks share one ordered SSH channel with
        // interactive pty.data frames. Waiting for client acks bounds how many
        // stream bytes a keystroke echo can queue behind, and yields the relay
        // event loop so incoming keystrokes are handled between chunks.
        if (pumpOptions.paceWithAcks) {
          while (
            seq - registry.ackedThroughSeq(streamId) > STREAM_ACK_WINDOW_CHUNKS &&
            !context.isStale() &&
            !registry.isAborted(streamId)
          ) {
            await registry.waitForAck(streamId)
          }
          if (context.isStale()) {
            endReason = 'stale'
            break
          }
          if (registry.isAborted(streamId)) {
            endReason = 'aborted'
            break
          }
        }
        const want = Math.min(STREAM_CHUNK_SIZE, totalSize - offset)
        const bytesRead = await readFullStreamChunk(entry.handle, buffer, want, offset)
        if (bytesRead !== want) {
          endReason = 'error'
          errorCode = 'ESTREAMTRUNCATED'
          errorMessage = `File truncated mid-stream: expected ${totalSize}, got ${offset + bytesRead}`
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
        // Why: the bulk lane waits out sink saturation, so a flood of chunk
        // frames cannot pile up in the outbound pipe ahead of interactive
        // pty.data frames written via plain notify().
        await dispatcher.notifyBulk(
          'fs.streamChunk',
          { streamId, seq, data },
          pumpOptions.clientId !== undefined ? { clientId: pumpOptions.clientId } : undefined
        )
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
      // Why: a dropped terminal frame hangs the reader forever, so it takes the control lane, which
      // never drops — but that lane KILLS the link when it overflows, hence the reserved slot held
      // until this frame settles. The per-chunk await already settled every chunk, so the control
      // frame cannot overtake stream data.
      const publishTerminal = (method: string, params: Record<string, unknown>): void => {
        if (pumpOptions.clientId === undefined) {
          // Legacy broadcast path (direct calls/tests): no per-frame settlement to hold the slot on.
          dispatcher.notifyControl(method, params)
          return
        }
        slotReleaseDeferred = dispatcher.tryNotifyClient(
          pumpOptions.clientId,
          method,
          params,
          releaseTerminalFrameSlot
        )
      }
      if (registry.isAborted(streamId)) {
        endReason = 'aborted'
      } else if (context.isStale()) {
        endReason = 'stale'
      }
      if (endReason === 'end') {
        publishTerminal('fs.streamEnd', { streamId })
        process.stderr.write(`[relay] stream end id=${streamId}\n`)
      } else if (endReason === 'error') {
        publishTerminal('fs.streamError', {
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
    // Why: the fd goes back first — a terminal frame that can never be delivered must not
    // strand it. Cancelled/stale streams publish nothing, so nothing else frees their slot.
    try {
      await registry.release(streamId)
    } finally {
      if (!slotReleaseDeferred) {
        releaseTerminalFrameSlot()
      }
    }
  }
}

// Why: fs.read() may return fewer bytes than requested before EOF. Fill each
// protocol chunk so strict clients reject corruption, not valid short reads.
// Shared with fs.readFileRange, where the same rule makes a short result mean
// EOF and nothing else.
export async function readFullStreamChunk(
  handle: StreamChunkReader,
  buffer: Buffer,
  length: number,
  offset: number
): Promise<number> {
  let totalRead = 0
  while (totalRead < length) {
    const { bytesRead } = await handle.read(
      buffer,
      totalRead,
      length - totalRead,
      offset + totalRead
    )
    if (bytesRead === 0) {
      break
    }
    totalRead += bytesRead
  }
  return totalRead
}
