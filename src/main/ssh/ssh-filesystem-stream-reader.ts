import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { JsonRpcErrorCode } from './relay-protocol'
import type { FileReadResult } from '../providers/types'
import {
  PreMetadataStreamFrameBuffer,
  STREAM_READER_INACTIVITY_TIMEOUT_MS,
  defaultSshPreMetadataStreamBudget,
  defaultSshStreamAssemblyBudget,
  type SshPreMetadataStreamBudget,
  type SshStreamAssemblyBudget,
  createStreamInactivityDeadline
} from './ssh-stream-reader-memory'
import {
  createFileStreamSetup,
  type FileStreamAssembler,
  StreamProtocolError
} from './ssh-file-stream-assembler'

export { StreamProtocolError } from './ssh-file-stream-assembler'

const SENTINEL_STREAM_ID = -1

export function isMethodNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  const code = (err as { code?: unknown }).code
  return code === JsonRpcErrorCode.MethodNotFound
}

export async function readFileViaStream(
  mux: SshChannelMultiplexer,
  filePath: string,
  options?: { inactivityTimeoutMs?: number },
  assemblyBudget: SshStreamAssemblyBudget = defaultSshStreamAssemblyBudget,
  preMetadataBudget: SshPreMetadataStreamBudget = defaultSshPreMetadataStreamBudget
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
    let assembler: FileStreamAssembler | null = null
    let settled = false

    // Why: chunk/end/error frames may arrive in the same dispatch tick as the
    // metadata response. Queue them until streamIdRef is set, then drain.
    const pending = new PreMetadataStreamFrameBuffer(preMetadataBudget)
    let metadataReady = false

    const inactivityMs = options?.inactivityTimeoutMs ?? STREAM_READER_INACTIVITY_TIMEOUT_MS
    const inactivity = createStreamInactivityDeadline(inactivityMs, () => {
      fail(new StreamProtocolError(`File stream stalled (>${inactivityMs}ms without data)`))
    })

    const cancelStreamId = (streamId: number): void => {
      if (!mux.isDisposed()) {
        try {
          mux.notify('fs.cancelStream', { streamId })
        } catch {
          // Best-effort
        }
      }
    }

    const cancel = (): void => {
      if (streamIdRef.current !== SENTINEL_STREAM_ID) {
        cancelStreamId(streamIdRef.current)
      }
    }

    const fail = (err: Error): void => {
      if (settled) {
        return
      }
      settled = true
      inactivity.clear()
      pending.clear()
      assembler?.release()
      assembler = null
      cancel()
      cleanup()
      reject(err)
    }

    const succeed = (value: FileReadResult): void => {
      if (settled) {
        return
      }
      settled = true
      inactivity.clear()
      pending.clear()
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
      if (!assembler) {
        fail(new StreamProtocolError(`Chunk arrived before metadata for stream ${id}`))
        return
      }
      let seq: number
      try {
        seq = assembler.acceptChunk(params, id)
      } catch (error) {
        fail(error as Error)
        return
      }
      inactivity.reset()
      // Why: credit-based flow control — the relay caps unacked chunks so bulk
      // stream frames cannot queue unbounded ahead of interactive pty.data
      // frames on the shared SSH channel. Old relays ignore this notification.
      try {
        mux.notify('fs.streamAck', { streamId: id, seq })
      } catch {
        // Disposal can race the write; teardown will settle the reader.
      }
    }

    const handleEnd = (params: Record<string, unknown>): void => {
      if (settled) {
        return
      }
      const id = params.streamId as number | undefined
      if (id !== streamIdRef.current) {
        return
      }
      if (!assembler) {
        fail(new StreamProtocolError(`Stream end before metadata for stream ${id}`))
        return
      }
      try {
        succeed(assembler.finish(id))
      } catch (error) {
        fail(error as Error)
      }
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
        const frame = pending.shift()
        if (!frame) {
          break
        }
        if (frame.kind === 'chunk') {
          handleChunk(frame.params)
        } else if (frame.kind === 'end') {
          handleEnd(frame.params)
        } else {
          handleStreamError(frame.params)
        }
      }
    }

    const pushPending = (
      kind: 'chunk' | 'end' | 'error',
      params: Record<string, unknown>
    ): void => {
      // Why: the stream id is unknown here; overload drops must not let one foreign frame fail every reader.
      pending.push({ kind, params })
    }

    unsubscribers.push(
      mux.onNotificationByMethod('fs.streamChunk', (params) => {
        if (!metadataReady) {
          pushPending('chunk', params)
          return
        }
        handleChunk(params)
      })
    )
    unsubscribers.push(
      mux.onNotificationByMethod('fs.streamEnd', (params) => {
        if (!metadataReady) {
          pushPending('end', params)
          return
        }
        handleEnd(params)
      })
    )
    unsubscribers.push(
      mux.onNotificationByMethod('fs.streamError', (params) => {
        if (!metadataReady) {
          pushPending('error', params)
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
      // Why: flowControl declares this client acks each chunk, letting a new
      // relay pace the pump. Old relays ignore the extra param and flood.
      .request('fs.readFileStream', { filePath, flowControl: 'ack' })
      .then((rawMetadata) => {
        if (settled) {
          const streamId = (rawMetadata as { streamId?: unknown } | null)?.streamId
          if (typeof streamId === 'number') {
            cancelStreamId(streamId)
          }
          return
        }
        let setup
        try {
          setup = createFileStreamSetup(rawMetadata, assemblyBudget)
        } catch (error) {
          const streamId = (rawMetadata as { streamId?: unknown } | null)?.streamId
          if (typeof streamId === 'number') {
            streamIdRef.current = streamId
          }
          fail(error as Error)
          return
        }
        if (setup.kind === 'empty') {
          succeed(setup.result)
          return
        }
        streamIdRef.current = setup.streamId
        assembler = setup.assembler
        metadataReady = true
        inactivity.reset()
        drainPending()
      })
      .catch((err) => {
        fail(err as Error)
      })
  })
}
