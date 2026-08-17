import type { Socket } from 'node:net'
import { encodeNdjson } from './ndjson'
import { DaemonProtocolError } from './types'
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
  onCreateCancellationFailure: () => void
  settleCreateCancellation: (sessionId: string, requestId: string) => Promise<{ canceled: boolean }>
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
          // Unmatched cancel: a create that already published a result will
          // still answer, so keep waiting — but only for a bounded window, or an
          // attach-only request queued behind a hung create never settles at all.
          if (!settled && !unmatchedCancelTimer) {
            unmatchedCancelTimer = setTimeout(
              () => rejectAndDrop(error),
              opts.unmatchedCancelGraceMs
            )
            unmatchedCancelTimer.unref?.()
          }
        })
        .catch(() => {
          if (!settled) {
            opts.onCreateCancellationFailure()
          }
        })
    }
    const timer = setTimeout(() => {
      const error = new DaemonProtocolError(`Request ${type} timed out after ${opts.timeoutMs}ms`)
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
    sent = true
    opts.socket.write(encoded)
  })
}
