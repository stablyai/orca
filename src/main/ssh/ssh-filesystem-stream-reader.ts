import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { STREAM_CHUNK_SIZE, JsonRpcErrorCode, RelayErrorCode } from './relay-protocol'
import type { FileReadResult } from '../providers/types'

const RESULT_ENCODING_BASE64 = 'base64'
const SENTINEL_STREAM_ID = -1

const MAX_PREVIEWABLE_BINARY_SIZE = 50 * 1024 * 1024
const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024

type StreamMetadataResponse = {
  streamId?: number
  totalSize: number
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  resultEncoding?: 'base64' | 'utf-8'
  empty?: boolean
}

export function isMethodNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  const code = (err as { code?: unknown }).code
  return code === JsonRpcErrorCode.MethodNotFound
}

export class StreamProtocolError extends Error {
  readonly code = RelayErrorCode.StreamProtocolError
  constructor(message: string) {
    super(message)
  }
}

export async function readFileViaStream(
  mux: SshChannelMultiplexer,
  filePath: string
): Promise<FileReadResult> {
  // Why: subscribe BEFORE awaiting the metadata response so a chunk arriving
  // immediately after the response cannot beat the listener registration.
  // streamIdRef stays at SENTINEL_STREAM_ID until metadata resolves; chunk
  // handlers compare against it and drop unmatched ids cleanly.
  const streamIdRef = { current: SENTINEL_STREAM_ID }
  const unsubscribers: (() => void)[] = []
  const cleanup = (): void => {
    while (unsubscribers.length > 0) {
      const fn = unsubscribers.pop()
      try {
        fn?.()
      } catch {
        // Best-effort cleanup
      }
    }
  }

  return new Promise<FileReadResult>((resolve, reject) => {
    let buffer: Buffer | null = null
    let resultEncoding: 'base64' | 'utf-8' = RESULT_ENCODING_BASE64
    let isBinary = false
    let isImage: boolean | undefined
    let mimeType: string | undefined
    let totalSize = 0
    let expectedSeq = 0
    let receivedChunks = 0
    let totalChunks = 0
    let settled = false

    // Why: chunk/end/error frames may arrive in the same dispatch tick as the
    // metadata response. Queue them until streamIdRef is set, then drain.
    type PendingFrame =
      | { kind: 'chunk'; params: Record<string, unknown> }
      | { kind: 'end'; params: Record<string, unknown> }
      | { kind: 'error'; params: Record<string, unknown> }
    const pending: PendingFrame[] = []
    let metadataReady = false

    const cancel = (): void => {
      if (streamIdRef.current !== SENTINEL_STREAM_ID && !mux.isDisposed()) {
        try {
          mux.notify('fs.cancelStream', { streamId: streamIdRef.current })
        } catch {
          // Best-effort
        }
      }
    }

    const fail = (err: Error): void => {
      if (settled) {
        return
      }
      settled = true
      cancel()
      cleanup()
      reject(err)
    }

    const succeed = (value: FileReadResult): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(value)
    }

    const handleChunk = (params: Record<string, unknown>): void => {
      if (settled) {
        return
      }
      const id = params.streamId as number | undefined
      if (id !== streamIdRef.current) {
        return
      }
      const seq = params.seq as number
      const data = params.data as string
      if (typeof seq !== 'number' || typeof data !== 'string') {
        fail(new StreamProtocolError(`Malformed chunk for stream ${id}`))
        return
      }
      if (seq !== expectedSeq) {
        fail(
          new StreamProtocolError(
            `Out-of-order chunk for stream ${id}: expected ${expectedSeq}, got ${seq}`
          )
        )
        return
      }
      const offset = seq * STREAM_CHUNK_SIZE
      const decoded = Buffer.from(data, 'base64')
      if (offset + decoded.length > totalSize) {
        fail(
          new StreamProtocolError(
            `Chunk overflows declared totalSize: offset=${offset} len=${decoded.length} total=${totalSize}`
          )
        )
        return
      }
      if (!buffer) {
        fail(new StreamProtocolError(`Chunk arrived before metadata for stream ${id}`))
        return
      }
      decoded.copy(buffer, offset)
      expectedSeq += 1
      receivedChunks += 1
    }

    const handleEnd = (params: Record<string, unknown>): void => {
      if (settled) {
        return
      }
      const id = params.streamId as number | undefined
      if (id !== streamIdRef.current) {
        return
      }
      if (receivedChunks !== totalChunks) {
        fail(
          new StreamProtocolError(
            `Chunk count mismatch for stream ${id}: expected ${totalChunks}, received ${receivedChunks}`
          )
        )
        return
      }
      if (!buffer) {
        fail(new StreamProtocolError(`Stream end before metadata for stream ${id}`))
        return
      }
      const content =
        resultEncoding === RESULT_ENCODING_BASE64
          ? buffer.toString('base64')
          : buffer.toString('utf-8')
      succeed({
        content,
        isBinary,
        ...(isImage !== undefined ? { isImage } : {}),
        ...(mimeType !== undefined ? { mimeType } : {})
      })
    }

    const handleStreamError = (params: Record<string, unknown>): void => {
      if (settled) {
        return
      }
      const id = params.streamId as number | undefined
      if (id !== streamIdRef.current) {
        return
      }
      const message = (params.message as string | undefined) ?? 'stream error'
      const code = (params.code as string | undefined) ?? 'ESTREAMERROR'
      const err = new Error(message) as Error & { code: string }
      err.code = code
      fail(err)
    }

    const drainPending = (): void => {
      while (!settled && pending.length > 0) {
        const frame = pending.shift()!
        if (frame.kind === 'chunk') {
          handleChunk(frame.params)
        } else if (frame.kind === 'end') {
          handleEnd(frame.params)
        } else {
          handleStreamError(frame.params)
        }
      }
    }

    unsubscribers.push(
      mux.onNotificationByMethod('fs.streamChunk', (params) => {
        if (!metadataReady) {
          pending.push({ kind: 'chunk', params })
          return
        }
        handleChunk(params)
      })
    )
    unsubscribers.push(
      mux.onNotificationByMethod('fs.streamEnd', (params) => {
        if (!metadataReady) {
          pending.push({ kind: 'end', params })
          return
        }
        handleEnd(params)
      })
    )
    unsubscribers.push(
      mux.onNotificationByMethod('fs.streamError', (params) => {
        if (!metadataReady) {
          pending.push({ kind: 'error', params })
          return
        }
        handleStreamError(params)
      })
    )

    const onDispose = mux.onDispose((reason) => {
      const message =
        reason === 'connection_lost'
          ? 'SSH connection lost, reconnecting...'
          : 'Multiplexer disposed'
      const err = new Error(message) as Error & { code: string }
      err.code = reason === 'connection_lost' ? 'CONNECTION_LOST' : 'DISPOSED'
      fail(err)
    })
    unsubscribers.push(onDispose)

    void mux
      .request('fs.readFileStream', { filePath })
      .then((rawMetadata) => {
        if (settled) {
          return
        }
        const metadata = rawMetadata as StreamMetadataResponse
        isBinary = metadata.isBinary
        isImage = metadata.isImage
        mimeType = metadata.mimeType
        resultEncoding = metadata.resultEncoding ?? RESULT_ENCODING_BASE64

        if (metadata.empty) {
          succeed({
            content: '',
            isBinary: metadata.isBinary,
            ...(metadata.isImage !== undefined ? { isImage: metadata.isImage } : {}),
            ...(metadata.mimeType !== undefined ? { mimeType: metadata.mimeType } : {})
          })
          return
        }

        if (typeof metadata.streamId !== 'number') {
          fail(new StreamProtocolError('Metadata missing streamId for non-empty stream'))
          return
        }

        const cap = metadata.isBinary ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_TEXT_FILE_SIZE
        if (metadata.totalSize < 0 || metadata.totalSize > cap) {
          streamIdRef.current = metadata.streamId
          fail(
            new StreamProtocolError(
              `Reported totalSize ${metadata.totalSize} exceeds client cap ${cap}`
            )
          )
          return
        }

        totalSize = metadata.totalSize
        totalChunks = totalSize === 0 ? 0 : Math.ceil(totalSize / STREAM_CHUNK_SIZE)
        try {
          buffer = Buffer.alloc(totalSize)
        } catch (err) {
          streamIdRef.current = metadata.streamId
          fail(new Error(`Failed to allocate ${totalSize} bytes: ${(err as Error).message}`))
          return
        }
        streamIdRef.current = metadata.streamId
        metadataReady = true
        drainPending()
      })
      .catch((err) => {
        fail(err as Error)
      })
  })
}
