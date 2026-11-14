import type { NdjsonRejectedRecord } from '../../shared/main-process-ndjson-framer'
import type { ZcodeAppServerConnectionHandlers } from './zcode-app-server-connection-types'
import { isProviderRecord } from '../provider-process/provider-json-record'
import {
  ZcodeAppServerRequestError,
  ZCODE_SESSION_BUSY_CODE
} from './zcode-app-server-request-error'
import { classifyJsonRpcPrefix } from '../../shared/json-rpc-record-prefix'

const OVERSIZED_REQUEST_ERROR_CODE = -32001
const MAX_REMEMBERED_TIMEOUTS = 64

export type ZcodePendingRequest = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function createZcodeAppServerRecordDispatcher(input: {
  handlers: ZcodeAppServerConnectionHandlers
  writeResponse: (payload: Record<string, unknown>) => void
  onProtocolFailure: (error: Error) => void
}): {
  addPending: (id: number, waiter: ZcodePendingRequest) => void
  deletePending: (id: number) => void
  timeOutPending: (id: number) => void
  failPending: (error: Error) => void
  dispatch: (message: Record<string, unknown>) => void
  rejectOversized: (rejected: NdjsonRejectedRecord & { kind: 'line-too-long' }) => void
} {
  const pending = new Map<number, ZcodePendingRequest>()
  const timedOutMethods = new Map<number, string>()

  const timeOutPending = (id: number): void => {
    const waiter = pending.get(id)
    if (!waiter) {
      return
    }
    pending.delete(id)
    timedOutMethods.set(id, waiter.method)
    const oldest = timedOutMethods.keys().next()
    if (timedOutMethods.size > MAX_REMEMBERED_TIMEOUTS && !oldest.done) {
      timedOutMethods.delete(oldest.value)
    }
  }

  const failPending = (error: Error): void => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    pending.clear()
  }

  const failPendingForOversizedUnknown = (
    record: NdjsonRejectedRecord & { kind: 'line-too-long' }
  ): void => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(
        new ZcodeAppServerRequestError(
          waiter.method,
          null,
          `zcode app-server reply to ${waiter.method} exceeded the ${record.maxLineBytes}-byte line limit`
        )
      )
    }
    pending.clear()
  }

  const dispatch = (message: Record<string, unknown>): void => {
    const method = message.method
    const id = message.id
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
      input.handlers.onServerRequest?.({
        id,
        method,
        params: message.params
      })
      return
    }
    if (typeof method === 'string') {
      input.handlers.onNotification?.(method, message.params)
      return
    }
    if (typeof message.id !== 'number') {
      input.handlers.onUnhandledFrame?.('frame:unclassified', message)
      return
    }
    const waiter = pending.get(message.id)
    if (!waiter) {
      const timedOutMethod = timedOutMethods.get(message.id)
      timedOutMethods.delete(message.id)
      const error = isProviderRecord(message.error) ? message.error.message : undefined
      console.warn(
        timedOutMethod
          ? `[zcode-app-server] late reply to ${timedOutMethod} after timeout (id ${message.id})`
          : `[zcode-app-server] reply with no waiting request (id ${message.id})`,
        ...(typeof error === 'string' ? [error] : [])
      )
      return
    }
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    const error = message.error
    if (isProviderRecord(error)) {
      const detail = typeof error.message === 'string' ? error.message : 'unknown error'
      waiter.reject(
        new ZcodeAppServerRequestError(
          waiter.method,
          typeof error.code === 'number' ? error.code : null,
          `zcode app-server ${waiter.method} failed: ${detail}`,
          typeof error.message === 'string' ? error.message : undefined
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
      const waiter = pending.get(classification.id)
      if (waiter) {
        pending.delete(classification.id)
        clearTimeout(waiter.timer)
        waiter.reject(
          new ZcodeAppServerRequestError(
            waiter.method,
            null,
            `zcode app-server reply to ${waiter.method} exceeded the ${rejected.maxLineBytes}-byte line limit`
          )
        )
      } else {
        input.handlers.onUnhandledFrame?.('frame:oversized-response', payload)
        failPendingForOversizedUnknown(rejected)
        input.onProtocolFailure(
          new Error(
            `zcode app-server oversized response ${classification.id} had no pending request`
          )
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
    if (classification.kind === 'notification') {
      input.handlers.onUnhandledFrame?.('frame:oversized-notification', payload)
      return
    }
    input.handlers.onUnhandledFrame?.('frame:oversized-unclassified', payload)
    input.onProtocolFailure(
      new Error(
        classification.kind === 'response-unknown'
          ? 'zcode app-server emitted an oversized response with an unknown shape'
          : 'zcode app-server emitted an oversized unclassifiable JSONL record'
      )
    )
  }

  return {
    addPending: (id, waiter) => pending.set(id, waiter),
    deletePending: (id) => pending.delete(id),
    timeOutPending,
    failPending,
    dispatch,
    rejectOversized
  }
}

/** Whether the error is ZCode refusing a send because a turn is already running. */
export function isZcodeSessionBusyError(error: unknown): boolean {
  return error instanceof ZcodeAppServerRequestError && error.code === ZCODE_SESSION_BUSY_CODE
}
