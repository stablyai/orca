import type { NdjsonRejectedRecord } from '../../shared/main-process-ndjson-framer'
import type { CodexAppServerConnectionHandlers } from './codex-app-server-connection-types'
import { CodexAppServerFrameSizeError } from './codex-app-server-frame-size-error'
import { isAppServerRecord } from './codex-app-server-jsonl'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import {
  CodexAppServerUnsupportedError,
  isCodexMethodNotFoundError
} from './codex-app-server-session'
import { classifyJsonRpcPrefix } from './codex-app-server-record-prefix'

const OVERSIZED_REQUEST_ERROR_CODE = -32001

export type CodexPendingRequest = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function createCodexAppServerRecordDispatcher(input: {
  handlers: CodexAppServerConnectionHandlers
  writeResponse: (payload: Record<string, unknown>) => void
  onProtocolFailure: (error: Error) => void
}): {
  addPending: (id: number, waiter: CodexPendingRequest) => void
  deletePending: (id: number) => void
  failPending: (error: Error) => void
  dispatch: (message: Record<string, unknown>) => void
  rejectOversized: (rejected: NdjsonRejectedRecord & { kind: 'line-too-long' }) => void
} {
  const pending = new Map<number, CodexPendingRequest>()

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
        new CodexAppServerFrameSizeError(waiter.method, record.observedBytes, record.maxLineBytes)
      )
    }
    pending.clear()
  }

  const dispatch = (message: Record<string, unknown>): void => {
    const hasMethod = typeof message.method === 'string'
    const hasId = typeof message.id === 'number' || typeof message.id === 'string'
    if (hasMethod && hasId) {
      input.handlers.onServerRequest?.({
        id: message.id as number | string,
        method: message.method as string,
        params: message.params
      })
      return
    }
    if (hasMethod) {
      input.handlers.onNotification?.(message.method as string, message.params)
      return
    }
    if (typeof message.id !== 'number') {
      input.handlers.onUnhandledFrame?.('frame:unclassified', message)
      return
    }
    const waiter = pending.get(message.id)
    if (!waiter) {
      input.handlers.onUnhandledFrame?.('response:unmatched', message)
      return
    }
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    const error = message.error
    if (isAppServerRecord(error)) {
      const detail = typeof error.message === 'string' ? error.message : 'unknown error'
      waiter.reject(
        isCodexMethodNotFoundError(error)
          ? new CodexAppServerUnsupportedError(
              `codex app-server does not support ${waiter.method}: ${detail}`
            )
          : new CodexAppServerRequestError(
              waiter.method,
              typeof error.code === 'number' ? error.code : null,
              `codex app-server ${waiter.method} failed: ${detail}`
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
          new CodexAppServerFrameSizeError(
            waiter.method,
            rejected.observedBytes,
            rejected.maxLineBytes
          )
        )
      } else {
        input.handlers.onUnhandledFrame?.('frame:oversized-response', payload)
        failPendingForOversizedUnknown(rejected)
        input.onProtocolFailure(
          new Error(
            `codex app-server oversized response ${classification.id} had no pending request`
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
          ? 'codex app-server emitted an oversized response with an unknown shape'
          : 'codex app-server emitted an oversized unclassifiable JSONL record'
      )
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
