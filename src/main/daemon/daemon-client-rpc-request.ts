import type { Socket } from 'node:net'
import { encodeNdjson } from './ndjson'
import {
  DAEMON_UNAVAILABLE_RECONNECT_MESSAGE,
  DaemonConnectionLostError,
  DaemonRequestTimeoutError
} from './types'
import { isTerminalAttachCanceledMessage } from './daemon-errors'
import type { DaemonPendingRequests } from './daemon-client-pending-requests'

type DaemonRpcRequestOptions = {
  socket: Socket
  pendingRequests: DaemonPendingRequests
  id: string
  type: string
  payload: unknown
  timeoutMs: number
  signal?: AbortSignal
  /**
   * How long to keep waiting after the daemon says it could not match a cancel.
   * A create that already published a result still has a response in flight, but
   * an attach-only request has nothing coming, so the wait must be bounded.
   */
  unmatchedCancelGraceMs: number
  /**
   * Escalation of last resort: called only when the cancel RPC could not be put on
   * the wire at all. Never called for a cancel the daemon answered with an error,
   * or one that timed out — those say nothing about the sibling sessions sharing
   * this connection. A cancel that timed out is instead reported through
   * `wedgedDaemonError` on this request alone.
   */
  onCreateCancellationFailure: () => void
  settleCreateCancellation: (sessionId: string, requestId: string) => Promise<{ canceled: boolean }>
}

/**
 * Why: the request timed out and so did the cancel sent to clean it up, so the daemon
 * is wedged with its socket still open — no close event, no disconnect, and nothing
 * else in the client notices (#8689 is the same shape). Re-message it to the one
 * string `isDaemonGoneError` matches, so the caller's retry can respawn the daemon
 * instead of retrying against a daemon that will never answer. Aborts are excluded:
 * the caller asked to stop, not to retry.
 */
function wedgedDaemonError(requestError: Error, cancelError: unknown): Error | null {
  if (
    !(requestError instanceof DaemonRequestTimeoutError) ||
    !(cancelError instanceof DaemonRequestTimeoutError)
  ) {
    return null
  }
  const wedged = new DaemonRequestTimeoutError(DAEMON_UNAVAILABLE_RECONNECT_MESSAGE)
  wedged.cause = requestError
  return wedged
}

export function requestDaemonRpc<T>(opts: DaemonRpcRequestOptions): Promise<T> {
  const { payload, type } = opts
  const createSessionId =
    type === 'createOrAttach' && payload !== null && typeof payload === 'object'
      ? Reflect.get(payload, 'sessionId')
      : null
  const requestPayload =
    type === 'createOrAttach' && payload !== null && typeof payload === 'object'
      ? { ...payload, cancelAfterMs: Math.max(1, opts.timeoutMs - 100) }
      : payload
  const encoded = encodeNdjson({
    id: opts.id,
    type,
    ...(requestPayload !== undefined ? { payload: requestPayload } : {})
  })

  return new Promise<T>((resolve, reject) => {
    let sent = false
    let cancellationStarted = false
    let settled = false
    let unmatchedCancelTimer: NodeJS.Timeout | null = null
    // Why: our cancel makes the daemon reject the request too (a queued create
    // abandoning an aborted wait). Callers key recovery off `client_disconnected`,
    // so letting that race pick the message rolls back terminals it should keep.
    // Scoped to the daemon's cancellation reply: a real disconnect still wins.
    let cancellationError: Error | null = null
    const removeAbortListener = (): void => opts.signal?.removeEventListener('abort', onAbort)
    const clearTimers = (): void => {
      clearTimeout(timer)
      if (unmatchedCancelTimer) {
        clearTimeout(unmatchedCancelTimer)
        unmatchedCancelTimer = null
      }
    }
    const rejectAndDrop = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      opts.pendingRequests.drop(opts.id)
      removeAbortListener()
      clearTimers()
      reject(error)
    }
    // Unmatched or unconfirmed cancel: a create that already published a result will
    // still answer, so keep waiting — but only for a bounded window, or an
    // attach-only request queued behind a hung create never settles at all.
    const awaitLateResponseThenReject = (error: Error): void => {
      if (settled || unmatchedCancelTimer) {
        return
      }
      unmatchedCancelTimer = setTimeout(() => rejectAndDrop(error), opts.unmatchedCancelGraceMs)
      unmatchedCancelTimer.unref?.()
    }
    const cancelCreate = (error: Error): void => {
      if (cancellationStarted) {
        return
      }
      cancellationStarted = true
      cancellationError = error
      clearTimeout(timer)
      if (!sent || typeof createSessionId !== 'string') {
        rejectAndDrop(error)
        return
      }
      void opts
        .settleCreateCancellation(createSessionId, opts.id)
        .then((result) => {
          if (result.canceled) {
            rejectAndDrop(error)
            return
          }
          awaitLateResponseThenReject(error)
        })
        .catch((cancelError: unknown) => {
          if (settled) {
            return
          }
          // Why: a cancel the daemon refused (v1-v10 answer 'Unknown request type')
          // or that blew its own 5s timeout (busy event loop, e.g. an unreachable UNC
          // share) proves nothing about the other sessions on this connection, so it
          // must not tear it down. Only an undeliverable cancel does. Unrecognized
          // errors deliberately fall through to the bounded wait: the fail-safe
          // direction is leaving siblings alone. A wedged daemon is still reported —
          // on this request only — via wedgedDaemonError.
          if (cancelError instanceof DaemonConnectionLostError) {
            opts.onCreateCancellationFailure()
            return
          }
          awaitLateResponseThenReject(wedgedDaemonError(error, cancelError) ?? error)
        })
    }
    const timer = setTimeout(() => {
      const error = new DaemonRequestTimeoutError(
        `Request ${type} timed out after ${opts.timeoutMs}ms`
      )
      if (typeof createSessionId === 'string') {
        cancelCreate(error)
      } else {
        rejectAndDrop(error)
      }
    }, opts.timeoutMs)
    const onAbort = (): void => {
      removeAbortListener()
      cancelCreate(new Error('client_disconnected'))
    }

    opts.pendingRequests.add(opts.id, {
      resolve: (value) => {
        settled = true
        removeAbortListener()
        clearTimers()
        resolve(value as T)
      },
      reject: (error) => {
        settled = true
        removeAbortListener()
        clearTimers()
        reject(
          cancellationError !== null && isTerminalAttachCanceledMessage(error.message)
            ? cancellationError
            : error
        )
      },
      timer
    })

    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) {
      onAbort()
      return
    }
    try {
      opts.socket.write(encoded)
      sent = true
    } catch (err) {
      // Why: an unwrapped throw here leaks the pending entry and its timer, and the
      // raw error would be indistinguishable from a daemon refusal.
      rejectAndDrop(new DaemonConnectionLostError(err instanceof Error ? err.message : String(err)))
    }
  })
}
