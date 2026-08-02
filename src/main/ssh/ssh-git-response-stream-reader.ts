import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { RelayErrorCode, isGitResponseStreamMarker } from './relay-protocol'

const SENTINEL_STREAM_ID = -1

/** Reject if no stream frame (chunk/end/error) arrives within this window,
 * reset on each frame. mux.request's own timeout only bounds the fast sentinel
 * response; without this, a relay pump that breaks on staleness (which sends no
 * responseEnd) while the SSH channel stays up would hang the client forever. */
const STREAM_INACTIVITY_TIMEOUT_MS = 30_000

/** Bound transient buffering of other concurrent streams' chunks while this
 * reader awaits its sentinel: every reader sees all git.responseChunk frames
 * and can't filter by streamId until its own sentinel resolves. Foreign frames
 * are dropped on drain anyway; this just caps the pre-sentinel backlog. */
const MAX_PENDING_FRAMES = 64

export class GitResponseStreamError extends Error {
  readonly code = RelayErrorCode.StreamProtocolError
  constructor(message: string) {
    super(message)
  }
}

type PendingFrame =
  | { kind: 'chunk'; params: Record<string, unknown> }
  | { kind: 'end'; params: Record<string, unknown> }
  | { kind: 'error'; params: Record<string, unknown> }

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
  }
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
    const parts: Buffer[] = []
    let expectedSeq = 0
    let receivedBytes = 0
    let totalBytes = 0
    let chunkCount = 0
    let settled = false
    let metadataReady = false
    const pending: PendingFrame[] = []

    const inactivityMs = options?.inactivityTimeoutMs ?? STREAM_INACTIVITY_TIMEOUT_MS
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null
    const clearInactivity = (): void => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer)
        inactivityTimer = null
      }
    }
    // Why: reset on every stream frame so a legitimately long stream is not
    // killed, but a wedged stream (no frames arriving) rejects instead of
    // hanging the caller forever.
    const armInactivity = (): void => {
      clearInactivity()
      inactivityTimer = setTimeout(() => {
        fail(
          new GitResponseStreamError(
            `Git response stream stalled (>${inactivityMs}ms without data)`
          )
        )
      }, inactivityMs)
      inactivityTimer.unref?.()
    }

    const cancel = (): void => {
      if (streamIdRef.current !== SENTINEL_STREAM_ID && !mux.isDisposed()) {
        try {
          mux.notify('git.cancelResponseStream', { streamId: streamIdRef.current })
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
      clearInactivity()
      cancel()
      cleanup()
      reject(err)
    }
    const succeed = (value: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearInactivity()
      cleanup()
      resolve(value)
    }

    const handleChunk = (p: Record<string, unknown>): void => {
      if (settled || p.streamId !== streamIdRef.current) {
        return
      }
      const seq = p.seq as number
      const data = p.data as string
      if (typeof seq !== 'number' || typeof data !== 'string') {
        fail(new GitResponseStreamError(`Malformed chunk for git stream ${streamIdRef.current}`))
        return
      }
      if (seq !== expectedSeq) {
        fail(
          new GitResponseStreamError(
            `Out-of-order chunk for git stream ${streamIdRef.current}: expected ${expectedSeq}, got ${seq}`
          )
        )
        return
      }
      const decoded = Buffer.from(data, 'base64')
      parts.push(decoded)
      receivedBytes += decoded.length
      expectedSeq += 1
      armInactivity()
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
      if (expectedSeq !== chunkCount || receivedBytes !== totalBytes) {
        fail(
          new GitResponseStreamError(
            `Git stream ${streamIdRef.current} incomplete: chunks ${expectedSeq}/${chunkCount}, bytes ${receivedBytes}/${totalBytes}`
          )
        )
        return
      }
      try {
        succeed(JSON.parse(Buffer.concat(parts).toString('utf-8')))
      } catch (err) {
        fail(
          new GitResponseStreamError(
            `Git stream ${streamIdRef.current} JSON parse failed: ${String(err)}`
          )
        )
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

    // Why: pre-sentinel we cannot filter by streamId (our id is unknown yet), so
    // every concurrent reader transiently buffers all readers' chunks. Cap the
    // backlog by dropping the oldest; foreign frames are dropped on drain anyway,
    // and if our own seq-0 were ever dropped the seq check fails loudly rather
    // than corrupting. The sentinel normally resolves long before this cap.
    const pushPending = (frame: PendingFrame): void => {
      pending.push(frame)
      if (pending.length > MAX_PENDING_FRAMES) {
        pending.shift()
      }
    }

    unsubscribers.push(
      mux.onNotificationByMethod('git.responseChunk', (p) => {
        if (!metadataReady) {
          pushPending({ kind: 'chunk', params: p })
          return
        }
        handleChunk(p)
      })
    )
    unsubscribers.push(
      mux.onNotificationByMethod('git.responseEnd', (p) => {
        if (!metadataReady) {
          pushPending({ kind: 'end', params: p })
          return
        }
        handleEnd(p)
      })
    )
    unsubscribers.push(
      mux.onNotificationByMethod('git.responseError', (p) => {
        if (!metadataReady) {
          pushPending({ kind: 'error', params: p })
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
          return
        }
        // Old relay / small result: plain single-frame value, no stream follows.
        if (!isGitResponseStreamMarker(result)) {
          succeed(result)
          return
        }
        const marker = result.__orcaGitResponseStream
        totalBytes = marker.totalBytes
        chunkCount = marker.chunkCount
        streamIdRef.current = marker.streamId
        metadataReady = true
        // Why: start the inactivity deadline now — mux.request's timeout only
        // covered the sentinel; the reassembly phase needs its own guard.
        armInactivity()
        drainPending()
      })
      .catch((err) => fail(err as Error))
  })
}
