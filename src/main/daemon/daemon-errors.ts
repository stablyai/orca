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

export class TerminalSessionOwnerUnverifiedError extends Error {
  constructor(sessionId: string) {
    super(`Terminal session owner could not be verified: ${sessionId}`)
    this.name = 'TerminalSessionOwnerUnverifiedError'
  }
}

export function decodeDaemonResponseError(message: string): Error {
  const prefix = 'Session not found: '
  return message.startsWith(prefix)
    ? new SessionNotFoundError(message.slice(prefix.length))
    : new DaemonProtocolError(message)
}
