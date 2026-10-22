/**
 * Shape checks for the frames a daemon client sends. JSON.parse yields anything — `null`, a
 * number, an object missing `id` — and one unchecked property read on such a frame throws out of
 * the socket handler and takes the daemon, and every PTY in it, down (#17841).
 */
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

/**
 * The routing envelope only: a request needs a string `id` to be answered and a string `type` to
 * be routed. Payload faults throw inside the router's try and come back as error replies.
 */
export function isDaemonRequestFrame(value: unknown): value is DaemonRequest {
  return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string'
}
