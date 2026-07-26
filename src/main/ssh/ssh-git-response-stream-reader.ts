import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import {
  MAX_GIT_RESPONSE_STREAM_BYTES,
  MAX_GIT_RESPONSE_STREAM_CHUNKS,
  isGitResponseStreamMarker
} from './relay-protocol'
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
  GitResponseStreamAssembler,
  GitResponseStreamError
} from './ssh-git-response-stream-assembler'

const SENTINEL_STREAM_ID = -1

export { GitResponseStreamError } from './ssh-git-response-stream-assembler'

/**
 * Request a git method that may return a large payload, opting into response
 * streaming so a big diff/exec response is chunked onto the relay's bulk lane
 * instead of one JSON-RPC frame (which would head-of-line-block pty.data echo
 * on the shared SSH channel).
 *
 * Cross-version behavior:
 * - New relay + big result → returns the stream sentinel; we reassemble chunks.
 * - New relay + small result, or old client → plain single-frame result.
 * - Old relay (ignores `__streamResponse`) → returns the plain result; the
 *   marker check fails and we return it directly, i.e. today's behavior.
 */
export function requestGitStreamable(
  mux: SshChannelMultiplexer,
  method: string,
  params: Record<string, unknown>,
  options?: {
    signal?: AbortSignal
    /** Bounds only the sentinel request (forwarded to mux.request), like today. */
    timeoutMs?: number
    /** Bounds the post-sentinel reassembly stall; resets on each chunk. */
    inactivityTimeoutMs?: number
  },
  assemblyBudget: SshStreamAssemblyBudget = defaultSshStreamAssemblyBudget,
  preMetadataBudget: SshPreMetadataStreamBudget = defaultSshPreMetadataStreamBudget
): Promise<unknown> {
  // Why: subscribe to chunk/end/error BEFORE awaiting the sentinel response so a
  // chunk that lands in the same dispatch tick as the response is not dropped
  // (mirrors readFileViaStream). streamIdRef stays SENTINEL until the sentinel
  // resolves; frames are queued until then and drained.
  const streamIdRef = { current: SENTINEL_STREAM_ID }
  const unsubscribers: (() => void)[] = []
  const cleanup = (): void => {
    while (unsubscribers.length > 0) {
      try {
        unsubscribers.pop()?.()
      } catch {
        // best-effort
      }
    }
  }

  return new Promise<unknown>((resolve, reject) => {
    let assembler: GitResponseStreamAssembler | null = null
    let settled = false
    let metadataReady = false
    const pending = new PreMetadataStreamFrameBuffer(preMetadataBudget)

    const inactivityMs = options?.inactivityTimeoutMs ?? STREAM_READER_INACTIVITY_TIMEOUT_MS
    const inactivity = createStreamInactivityDeadline(inactivityMs, () => {
      fail(
        new GitResponseStreamError(`Git response stream stalled (>${inactivityMs}ms without data)`)
      )
    })

    const cancelStreamId = (streamId: number): void => {
      if (streamId !== SENTINEL_STREAM_ID && !mux.isDisposed()) {
        try {
          mux.notify('git.cancelResponseStream', { streamId })
        } catch {
          // best-effort
        }
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
      cancelStreamId(streamIdRef.current)
      cleanup()
      reject(err)
    }
    const succeed = (value: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      inactivity.clear()
      pending.clear()
      cleanup()
      resolve(value)
    }

    const handleChunk = (p: Record<string, unknown>): void => {
      if (settled || p.streamId !== streamIdRef.current) {
        return
      }
      if (!assembler) {
        fail(
          new GitResponseStreamError(
            `Chunk arrived before metadata for git stream ${streamIdRef.current}`
          )
        )
        return
      }
      let seq: number
      try {
        seq = assembler.acceptChunk(p)
      } catch (error) {
        fail(error as Error)
        return
      }
      inactivity.reset()
      // Why: credit-based flow control — the relay caps unacked chunks so a big
      // response cannot queue unbounded ahead of interactive pty.data frames.
      if (!mux.isDisposed()) {
        try {
          mux.notify('git.responseAck', { streamId: streamIdRef.current, seq })
        } catch {
          // Disposal can race the check; the ACK is best-effort during teardown.
        }
      }
    }

    const handleEnd = (p: Record<string, unknown>): void => {
      if (settled || p.streamId !== streamIdRef.current) {
        return
      }
      if (!assembler) {
        fail(
          new GitResponseStreamError(
            `Stream end before metadata for git stream ${streamIdRef.current}`
          )
        )
        return
      }
      try {
        succeed(assembler.finish())
      } catch (error) {
        fail(error as Error)
      }
    }

    const handleStreamError = (p: Record<string, unknown>): void => {
      if (settled || p.streamId !== streamIdRef.current) {
        return
      }
      fail(new Error((p.message as string | undefined) ?? 'git response stream error'))
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
      mux.onNotificationByMethod('git.responseChunk', (p) => {
        if (!metadataReady) {
          pushPending('chunk', p)
          return
        }
        handleChunk(p)
      })
    )
    unsubscribers.push(
      mux.onNotificationByMethod('git.responseEnd', (p) => {
        if (!metadataReady) {
          pushPending('end', p)
          return
        }
        handleEnd(p)
      })
    )
    unsubscribers.push(
      mux.onNotificationByMethod('git.responseError', (p) => {
        if (!metadataReady) {
          pushPending('error', p)
          return
        }
        handleStreamError(p)
      })
    )
    unsubscribers.push(
      mux.onDispose((reason) => {
        const err = new Error(
          reason === 'connection_lost'
            ? 'SSH connection lost, reconnecting...'
            : 'Multiplexer disposed'
        ) as Error & { code: string }
        err.code = reason === 'connection_lost' ? 'CONNECTION_LOST' : 'DISPOSED'
        fail(err)
      })
    )

    if (options?.signal) {
      const signal = options.signal
      if (signal.aborted) {
        const err = new Error('Request was cancelled') as Error & { name: string }
        err.name = 'AbortError'
        fail(err)
        return
      }
      const onAbort = (): void => {
        const err = new Error('Request was cancelled') as Error & { name: string }
        err.name = 'AbortError'
        fail(err)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      unsubscribers.push(() => signal.removeEventListener('abort', onAbort))
    }

    // Why: forward only the mux-request options (signal/timeoutMs) and omit them
    // entirely when absent, so callers that previously issued a 2-arg
    // mux.request keep the same call shape (and their tests). inactivityTimeoutMs
    // governs reassembly here, not the sentinel request.
    const streamParams = { ...params, __streamResponse: true }
    const requestOptions =
      options?.signal !== undefined || options?.timeoutMs !== undefined
        ? { signal: options.signal, timeoutMs: options.timeoutMs }
        : undefined
    const requestPromise = requestOptions
      ? mux.request(method, streamParams, requestOptions)
      : mux.request(method, streamParams)
    void requestPromise
      .then((result) => {
        if (settled) {
          if (isGitResponseStreamMarker(result)) {
            cancelStreamId(result.__orcaGitResponseStream.streamId)
          }
          return
        }
        // Old relay / small result: plain single-frame value, no stream follows.
        if (!isGitResponseStreamMarker(result)) {
          if (
            typeof result === 'object' &&
            result !== null &&
            '__orcaGitResponseStream' in result
          ) {
            fail(new GitResponseStreamError('Malformed Git response stream metadata'))
            return
          }
          succeed(result)
          return
        }
        const marker = result.__orcaGitResponseStream
        streamIdRef.current = marker.streamId
        if (
          marker.totalBytes > MAX_GIT_RESPONSE_STREAM_BYTES ||
          marker.chunkCount > MAX_GIT_RESPONSE_STREAM_CHUNKS
        ) {
          fail(
            new GitResponseStreamError(
              `Git response stream exceeds client limit (${marker.totalBytes} bytes, ${marker.chunkCount} chunks)`
            )
          )
          return
        }
        try {
          assembler = new GitResponseStreamAssembler(
            marker.streamId,
            marker.totalBytes,
            marker.chunkCount,
            assemblyBudget
          )
        } catch (error) {
          fail(error as Error)
          return
        }
        metadataReady = true
        // Why: start the inactivity deadline now — mux.request's timeout only
        // covered the sentinel; the reassembly phase needs its own guard.
        inactivity.reset()
        drainPending()
      })
      .catch((err) => fail(err as Error))
  })
}
