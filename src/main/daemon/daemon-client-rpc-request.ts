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
  /** Bound late-response waits after unmatched cancellation, including attach-only requests with no reply coming. */
  unmatchedCancelGraceMs: number
  /** Tear down only for undeliverable cancels; refusals and timeouts do not imply sibling transport failure. */
  onCreateCancellationFailure: () => void
  settleCreateCancellation: (sessionId: string, requestId: string) => Promise<{ canceled: boolean }>
}

// Matching request/cancel timeouts signal a wedged daemon to retry logic; caller aborts do not.
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
  // A stalled event loop can deliver a daemon cancellation before its overdue timer runs.
  const { payload, type } = opts
  const createTimeoutError = (): DaemonRequestTimeoutError =>
    new DaemonRequestTimeoutError(`Request ${type} timed out after ${opts.timeoutMs}ms`)
  const createSessionId =
    type === 'createOrAttach' &&
    payload !== null &&
    typeof payload === 'object' &&
    'sessionId' in payload
      ? payload.sessionId
      : null
  const requestPayload =
    type === 'createOrAttach' && payload !== null && typeof payload === 'object'
      ? {
          ...payload,
          cancelAfterMs: Math.max(1, opts.timeoutMs + opts.unmatchedCancelGraceMs)
        }
      : payload
  const encoded = encodeNdjson({
    id: opts.id,
    type,
    ...(requestPayload !== undefined ? { payload: requestPayload } : {})
  })
  const clientDeadlineMs = performance.now() + opts.timeoutMs

  return new Promise<T>((resolve, reject) => {
    let sent = false
    let cancellationStarted = false
    let settled = false
    let unmatchedCancelTimer: NodeJS.Timeout | null = null
    // Preserve the caller's cancellation error over a racing daemon reply; real disconnects still win.
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
    // Allow a published create reply to arrive, but bound attach-only waits that may never get a response.
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
          // Refused, timed-out or unknown cancel failures must leave sibling sessions on the connection intact.
          if (cancelError instanceof DaemonConnectionLostError) {
            opts.onCreateCancellationFailure()
            return
          }
          awaitLateResponseThenReject(wedgedDaemonError(error, cancelError) ?? error)
        })
    }
    const timer = setTimeout(() => {
      const error = createTimeoutError()
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
          isTerminalAttachCanceledMessage(error.message)
            ? (cancellationError ??
                (type === 'createOrAttach' && performance.now() >= clientDeadlineMs
                  ? createTimeoutError()
                  : error))
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
      // Wrap transport throws and drop the pending timer so they cannot masquerade as daemon refusals.
      rejectAndDrop(new DaemonConnectionLostError(err instanceof Error ? err.message : String(err)))
    }
  })
}
