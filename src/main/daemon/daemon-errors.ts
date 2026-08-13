import { PtyWriteUnavailableError } from '../providers/pty-write-unavailable-error'
// Error classes shared across the daemon protocol boundary (client, server,
// host). Split from types.ts, which is capped for wire-shape declarations.
export class TerminalAttachCanceledError extends Error {
  constructor(sessionId: string) {
    super(`Attach canceled for session ${sessionId}`)
    this.name = 'TerminalAttachCanceledError'
  }
}

export class DaemonProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonProtocolError'
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}

/**
 * A PtyWriteUnavailableError so a throw partway through a paste reaches the renderer as
 * `pty:writeUnavailable` and the pane re-attaches, instead of the remaining chunks vanishing
 * with nothing to explain the gap.
 *
 * Deliberately not a SessionNotFoundError: that is matched by isPtyAlreadyGoneError and would
 * be synthesized into an exit the session never had — the same lie one layer down.
 */
export class TerminalSessionOwnerUnverifiedError extends PtyWriteUnavailableError {
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
