import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { createSshDisposalError } from './ssh-channel-multiplexer'
import { RelayErrorCode, isGitResponseStreamMarker } from './relay-protocol'

const SENTINEL_STREAM_ID = -1

/** Reject if no stream frame (chunk/end/error) arrives within this window,
 * reset on each frame. mux.request's own timeout only bounds the fast sentinel
 * response; without this, a relay pump that breaks on staleness (which sends no
 * responseEnd) while the SSH channel stays up would hang the client forever. */
const STREAM_INACTIVITY_TIMEOUT_MS = 30_000

export class GitResponseStreamError extends Error {
  readonly code = RelayErrorCode.StreamProtocolError
  constructor(message: string) {
    super(message)
  }
}

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
  // (mirrors readFileViaStream). The sentinel installs streamIdRef synchronously
  // via mux.request's beforeResolve, so our own frames always pass the id filter
  // and frames arriving earlier are foreign by definition — dropped, not queued.
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
    // Install metadata during response dispatch, before adjacent stream frames.
    let metadataReady = false

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
      if (inactivityTimer) {
        inactivityTimer.refresh()
        return
      }
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

    unsubscribers.push(
      mux.onNotificationByMethod('git.responseChunk', (p) => {
        if (!metadataReady) {
          return
        }
        handleChunk(p)
      })
    )
    unsubscribers.push(
      mux.onNotificationByMethod('git.responseEnd', (p) => {
        if (!metadataReady) {
          return
        }
        handleEnd(p)
      })
    )
    unsubscribers.push(
      mux.onNotificationByMethod('git.responseError', (p) => {
        if (!metadataReady) {
          return
        }
        handleStreamError(p)
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

    // Why: registered last because an already-disposed mux fails synchronously here,
    // and that cleanup must be able to drop the abort listener above (#11953).
    unsubscribers.push(mux.onDispose((reason) => fail(createSshDisposalError(reason))))

    // Why: the sentinel installs the stream identity synchronously inside
    // beforeResolve — the multiplexer runs it during response dispatch, before
    // resolve() and before any same-turn frames that follow. inactivityTimeoutMs
    // governs reassembly here, not the sentinel request.
    const streamParams = { ...params, __streamResponse: true }
    void mux
      .request(method, streamParams, {
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        beforeResolve: (result) => {
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
        }
      })
      // Why: beforeResolve is an optional hook; if a mux ever resolves without
      // running it, the stream identity never installs and no deadline is armed
      // (the request timer clears before resolve) — fail instead of hanging.
      .then(() => {
        if (!settled && !metadataReady) {
          fail(new GitResponseStreamError('Git stream response resolved without stream identity'))
        }
      })
      .catch((err) => fail(err as Error))
  })
}
