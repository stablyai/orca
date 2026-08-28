// Error classes shared across the daemon protocol boundary (client, server,
// host). Split from types.ts, which is capped for wire-shape declarations.
const ATTACH_CANCELED_PREFIX = 'Attach canceled for session '

export class TerminalAttachCanceledError extends Error {
  constructor(sessionId: string) {
    super(`${ATTACH_CANCELED_PREFIX}${sessionId}`)
    this.name = 'TerminalAttachCanceledError'
  }
}

/** Recognizes the daemon's attach-cancellation across the wire, where only the message survives. */
export function isTerminalAttachCanceledMessage(message: string): boolean {
  return message.startsWith(ATTACH_CANCELED_PREFIX)
}

export class DaemonProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonProtocolError'
  }
}

/**
 * The control connection itself failed: nothing was delivered and no reply is
 * coming. Distinct from a DaemonProtocolError the daemon actually answered with
 * (or one we raised on our own timeout) — only this class proves the socket, and
 * therefore every session sharing it, is already lost. Extends
 * DaemonProtocolError and keeps the same messages so existing instanceof and
 * message checks (isDaemonGoneError) still match.
 */
export class DaemonConnectionLostError extends DaemonProtocolError {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonConnectionLostError'
  }
}

/**
 * Nothing came back before our own deadline. The daemon may still be alive and merely
 * slow, so this is not a connection loss — but a request AND the cancel sent to clean
 * it up both hitting this means the daemon is wedged with its socket still open.
 */
export class DaemonRequestTimeoutError extends DaemonProtocolError {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonRequestTimeoutError'
  }
}

/**
 * The one message `isDaemonGoneError` matches that a still-open connection can produce,
 * so it is the only way a wedged-but-connected daemon reaches the respawn path.
 */
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

// Connect ENOENT/ECONNREFUSED proves the endpoint is absent; open ENOENT can be a missing token file.
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
