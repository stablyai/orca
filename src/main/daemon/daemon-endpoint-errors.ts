import { DAEMON_ENDPOINT_LOST_MESSAGE } from './daemon-endpoint-ownership'
import { DaemonConnectionLostError } from './daemon-errors'
import { DAEMON_UNAVAILABLE_RECONNECT_MESSAGE } from './types'

/**
 * Narrow on purpose: only the daemon's own reply for a request type it does not implement.
 * A transient failure must stay unproven rather than be mistaken for a missing capability.
 * The server throws `Unknown request type: <type>`; the client rejects with that text, which
 * `addNodePtyRecoveryHint` only ever prepends to.
 */
export function isUnknownRequestTypeError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Unknown request type')
}

// Why: syscall='connect' distinguishes a dead-socket ENOENT/ECONNREFUSED from token-file ENOENT (no syscall);
// message strings incl. wedged-daemon "Hello response timed out" (#8689) also warrant a respawn.
export function isDaemonGoneError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false
  }
  if (err instanceof DaemonConnectionLostError) {
    return true
  }
  const errno = err as NodeJS.ErrnoException
  if ((errno.code === 'ENOENT' || errno.code === 'ECONNREFUSED') && errno.syscall === 'connect') {
    return true
  }
  const msg = err.message
  return (
    msg === 'Connection lost' ||
    msg === 'Not connected' ||
    msg === 'Hello response timed out' ||
    msg === DAEMON_UNAVAILABLE_RECONNECT_MESSAGE ||
    msg === DAEMON_ENDPOINT_LOST_MESSAGE
  )
}

export function isMissingWindowsNamedPipeError(err: unknown): boolean {
  if (process.platform !== 'win32' || !(err instanceof Error)) {
    return false
  }
  const errno = err as NodeJS.ErrnoException
  return errno.code === 'ENOENT' && errno.syscall === 'connect'
}
