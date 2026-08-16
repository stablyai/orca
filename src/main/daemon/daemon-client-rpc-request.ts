import type { Socket } from 'node:net'
import { encodeNdjson } from './ndjson'
import { DaemonProtocolError } from './types'
import type { DaemonPendingRequests } from './daemon-client-pending-requests'

type DaemonRpcRequestOptions = {
  socket: Socket
  pendingRequests: DaemonPendingRequests
  id: string
  type: string
  payload: unknown
  timeoutMs: number
  signal?: AbortSignal
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
    const removeAbortListener = (): void => opts.signal?.removeEventListener('abort', onAbort)
    const rejectAndDrop = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      opts.pendingRequests.drop(opts.id)
      removeAbortListener()
      clearTimeout(timer)
      reject(error)
    }
    const cancelCreate = (error: Error): void => {
      if (cancellationStarted) {
        return
      }
      cancellationStarted = true
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
        resolve(value as T)
      },
      reject: (error) => {
        settled = true
        removeAbortListener()
        reject(error)
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
