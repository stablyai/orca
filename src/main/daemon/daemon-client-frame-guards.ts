// Validate parsed JSON before socket handlers access it; malformed frames must not crash the daemon.
import type { DaemonRequest, HelloMessage } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Field types only; the caller still checks version, token and role values for its replies. */
export function isHelloFrame(value: unknown): value is HelloMessage {
  return (
    isRecord(value) &&
    value.type === 'hello' &&
    typeof value.version === 'number' &&
    typeof value.token === 'string' &&
    typeof value.clientId === 'string' &&
    typeof value.role === 'string'
  )
}

/** Check only routing fields; payload validation failures become router error replies. */
export function isDaemonRequestFrame(value: unknown): value is DaemonRequest {
  return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string'
}
