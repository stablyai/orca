import { isSafeTimerDelayMs } from '../../shared/timer-delay'

export type AcpPeerOptions = {
  maxLineBytes?: number
  maxQueuedWriteBytes?: number
  maxPendingRequests?: number
  maxIncomingRequests?: number
  requestTimeoutMs?: number | null
  /** A managed connection waits for process exit rather than treating stdout EOF as exit. */
  closeOnInputEnd?: boolean
}

export function resolveAcpPeerOptions(options: AcpPeerOptions = {}): Required<AcpPeerOptions> {
  return {
    maxLineBytes: bounded(options.maxLineBytes, 16 * 1024 * 1024),
    maxQueuedWriteBytes: bounded(options.maxQueuedWriteBytes, 32 * 1024 * 1024),
    maxPendingRequests: bounded(options.maxPendingRequests, 128),
    maxIncomingRequests: bounded(options.maxIncomingRequests, 128),
    requestTimeoutMs: requestTimeout(options.requestTimeoutMs),
    closeOnInputEnd: options.closeOnInputEnd ?? true
  }
}

export function bounded(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('ACP limits must be positive finite integers')
  }
  return value
}

export function requestTimeout(value: number | null | undefined): number | null {
  if (value == null) {
    return null
  }
  if (!isSafeTimerDelayMs(value) || value <= 0) {
    throw new Error('ACP timeouts must be positive finite timer durations')
  }
  return value
}
