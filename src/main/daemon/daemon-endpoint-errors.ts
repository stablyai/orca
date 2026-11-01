import { DAEMON_ENDPOINT_LOST_MESSAGE } from './daemon-endpoint-ownership'
import { DaemonConnectionLostError } from './daemon-errors'
import { DAEMON_UNAVAILABLE_RECONNECT_MESSAGE } from './types'

/** Match the server's unknown-request reply; transient errors do not prove a missing capability. */
export function isUnknownRequestTypeError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Unknown request type')
}

// Require connect errors to exclude missing token files; hello timeouts also permit respawn.
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
