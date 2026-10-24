const ATTACH_CANCELED_PREFIX = 'Attach canceled for session '

export class TerminalAttachCanceledError extends Error {
  constructor(sessionId: string) {
    super(`${ATTACH_CANCELED_PREFIX}${sessionId}`)
    this.name = 'TerminalAttachCanceledError'
  }
}

/** Only the error message survives daemon transport. */
export function isTerminalAttachCanceledMessage(message: string): boolean {
  return message.startsWith(ATTACH_CANCELED_PREFIX)
}

export class DaemonProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonProtocolError'
  }
}

/** Control transport failed; every session sharing it needs reconnection, regardless of request delivery. */
export class DaemonConnectionLostError extends DaemonProtocolError {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonConnectionLostError'
  }
}

/** A request deadline alone does not establish connection loss. */
export class DaemonRequestTimeoutError extends DaemonProtocolError {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonRequestTimeoutError'
  }
}

/** Route an unresponsive but still-connected daemon through legacy reconnect matching. */
export const DAEMON_UNAVAILABLE_RECONNECT_MESSAGE = 'Daemon temporarily unavailable; reconnect'

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}

export class TerminalSessionOwnerUnverifiedError extends Error {
  constructor(sessionId: string) {
    super(`Terminal session owner could not be verified: ${sessionId}`)
    this.name = 'TerminalSessionOwnerUnverifiedError'
  }
}

export class TerminalHostGoneError extends Error {
  constructor() {
    super('terminal_host_gone')
    this.name = 'TerminalHostGoneError'
  }
}

// Connect errors establish endpoint failure; open ENOENT may only mean a missing token file.
export function isDaemonEndpointGoneError(err: unknown): boolean {
  const candidate = err as { code?: unknown; syscall?: unknown } | null
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    candidate.syscall === 'connect' &&
    (candidate.code === 'ENOENT' || candidate.code === 'ECONNREFUSED')
  )
}

export function decodeDaemonResponseError(message: string): Error {
  const prefix = 'Session not found: '
  return message.startsWith(prefix)
    ? new SessionNotFoundError(message.slice(prefix.length))
    : new DaemonProtocolError(message)
}
