import { classifyJsonRpcPrefix } from '../../../shared/json-rpc-record-prefix'
import type { NdjsonRejectedRecord } from '../../../shared/main-process-ndjson-framer'
import { isProviderRecord } from '../../provider-process/provider-json-record'
import {
  isZcodeMethodNotFoundError,
  ZcodeAppServerFrameSizeError,
  ZcodeAppServerRequestError,
  ZcodeAppServerUnsupportedError
} from './zcode-app-server-errors'
import type { ZcodeAppServerConnectionHandlers } from './zcode-app-server-connection-types'

const OVERSIZED_REQUEST_ERROR_CODE = -32001

type PendingRequest = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
  /** Runs on reply/timeout before promise continuations; replies retain stdout notification order. */
  onReply?: (result?: unknown) => void
}

export function createZcodeAppServerRecordDispatcher(input: {
  handlers: ZcodeAppServerConnectionHandlers
  writeResponse: (payload: Record<string, unknown>) => void
  onProtocolFailure: (error: Error) => void
}): {
  addPending: (id: number, waiter: PendingRequest) => void
  deletePending: (id: number) => void
  failPending: (error: Error) => void
  dispatch: (message: Record<string, unknown>) => void
  rejectOversized: (rejected: NdjsonRejectedRecord & { kind: 'line-too-long' }) => void
} {
  const pending = new Map<number, PendingRequest>()

  const failPending = (error: Error): void => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    pending.clear()
  }

  // zcode speaks line-delimited JSON with no `jsonrpc` field: `id`+`method` is a request (either
  // direction), `method` alone a notification, `id` alone a reply to this client's pending call.
  const dispatch = (message: Record<string, unknown>): void => {
    const hasMethod = typeof message.method === 'string'
    const hasId = typeof message.id === 'number' || typeof message.id === 'string'
    if (hasMethod && hasId) {
      input.handlers.onServerRequest?.({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
        id: message.id as number | string,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
        method: message.method as string,
        params: message.params
      })
      return
    }
    if (hasMethod) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      input.handlers.onNotification?.(message.method as string, message.params)
      return
    }
    if (typeof message.id !== 'number') {
      input.handlers.onUnhandledFrame?.('frame:unclassified', message)
      return
    }
    const waiter = pending.get(message.id)
    if (!waiter) {
      // Late/unmatched replies belong in diagnostics; no waiting call can interpret them.
      console.warn(`[zcode-app-server] reply with no waiting request (id ${message.id})`)
      return
    }
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    const error = message.error
    waiter.onReply?.(isProviderRecord(error) ? undefined : message.result)
    if (isProviderRecord(error)) {
      const detail = typeof error.message === 'string' ? error.message : 'unknown error'
      waiter.reject(
        isZcodeMethodNotFoundError(error)
          ? new ZcodeAppServerUnsupportedError(
              `zcode app-server does not support ${waiter.method}: ${detail}`
            )
          : new ZcodeAppServerRequestError(
              waiter.method,
              typeof error.code === 'number' ? error.code : null,
              `zcode app-server ${waiter.method} failed: ${detail}`,
              typeof error.message === 'string' ? error.message : undefined,
              error.data
            )
      )
      return
    }
    waiter.resolve(message.result)
  }

  const rejectOversized = (rejected: NdjsonRejectedRecord & { kind: 'line-too-long' }): void => {
    const classification = classifyJsonRpcPrefix(rejected.prefix)
    const payload = {
      reason: 'record-too-large',
      observedBytes: rejected.observedBytes,
      maxBytes: rejected.maxLineBytes,
      classification: classification.kind,
      ...('id' in classification ? { id: classification.id } : {}),
      ...('method' in classification ? { method: classification.method } : {})
    }
    if (classification.kind === 'response') {
      const waiter =
        typeof classification.id === 'number' ? pending.get(classification.id) : undefined
      if (waiter) {
        pending.delete(classification.id)
        clearTimeout(waiter.timer)
        waiter.reject(
          new ZcodeAppServerFrameSizeError(
            waiter.method,
            rejected.observedBytes,
            rejected.maxLineBytes
          )
        )
      } else {
        input.handlers.onUnhandledFrame?.('frame:oversized-response', payload)
        input.onProtocolFailure(
          new Error('zcode app-server oversized response had no pending request')
        )
        return
      }
      input.handlers.onUnhandledFrame?.('frame:oversized-response', payload)
      return
    }
    if (classification.kind === 'server-request') {
      input.writeResponse({
        id: classification.id,
        error: {
          code: OVERSIZED_REQUEST_ERROR_CODE,
          message: `request exceeds ${rejected.maxLineBytes} byte limit`
        }
      })
      input.handlers.onUnhandledFrame?.('frame:oversized-request', payload)
      return
    }
    input.handlers.onUnhandledFrame?.(
      classification.kind === 'notification'
        ? 'frame:oversized-notification'
        : 'frame:oversized-unclassified',
      payload
    )
  }

  return {
    addPending: (id, waiter) => pending.set(id, waiter),
    deletePending: (id) => pending.delete(id),
    failPending,
    dispatch,
    rejectOversized
  }
}
