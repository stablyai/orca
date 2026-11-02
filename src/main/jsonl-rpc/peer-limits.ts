import { isSafeTimerDelayMs } from '../../shared/timer-delay'

export type JsonlRpcPeerOptions = {
  maxLineBytes?: number
  maxQueuedWriteBytes?: number
  maxPendingRequests?: number
  requestTimeoutMs?: number
}

export function resolveJsonlRpcPeerOptions(
  options: JsonlRpcPeerOptions = {}
): Required<JsonlRpcPeerOptions> {
  return {
    maxLineBytes: positiveInteger(options.maxLineBytes, 8 * 1024 * 1024),
    maxQueuedWriteBytes: positiveInteger(options.maxQueuedWriteBytes, 32 * 1024 * 1024),
    maxPendingRequests: positiveInteger(options.maxPendingRequests, 128),
    requestTimeoutMs: jsonlRpcRequestTimeout(options.requestTimeoutMs ?? 30_000)
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('JSON-lines RPC limits must be positive finite integers')
  }
  return value
}

export function jsonlRpcRequestTimeout(value: number): number {
  if (!isSafeTimerDelayMs(value) || value <= 0) {
    throw new RangeError('JSON-lines RPC timeout must be a positive finite timer duration')
  }
  return value
}
