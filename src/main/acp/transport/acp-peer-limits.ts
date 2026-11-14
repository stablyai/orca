import { isSafeTimerDelayMs } from '../../../shared/timer-delay'

// Under the ACP SDK's 32 MiB stdin line limit (OpenCode 2); a longer line kills the agent.
export const ACP_MAX_LINE_BYTES = 31 * 1024 * 1024

export type AcpPeerOptions = {
  maxLineBytes?: number
  maxQueuedWriteBytes?: number
  maxPendingRequests?: number
  maxIncomingRequests?: number
  requestTimeoutMs?: number | null
  /** Managed connections use process exit, not stdout EOF. */
  closeOnInputEnd?: boolean
}

export function resolveAcpPeerOptions(options: AcpPeerOptions = {}): Required<AcpPeerOptions> {
  return {
    maxLineBytes: bounded(options.maxLineBytes, ACP_MAX_LINE_BYTES),
    maxQueuedWriteBytes: bounded(options.maxQueuedWriteBytes, 2 * ACP_MAX_LINE_BYTES),
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
