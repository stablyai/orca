import type { CodexAppServerConnection } from './codex-app-server-connection-types'

export class CodexAppServerHandshakeExitUnprovenError extends Error {
  constructor(
    readonly connection: CodexAppServerConnection,
    cause: unknown
  ) {
    super('codex app-server handshake failed without process-exit proof', { cause })
    this.name = 'CodexAppServerHandshakeExitUnprovenError'
  }
}

export function isCodexAppServerHandshakeExitUnprovenError(
  error: unknown
): error is CodexAppServerHandshakeExitUnprovenError {
  const connection =
    error instanceof Error && 'connection' in error
      ? (error.connection as Partial<CodexAppServerConnection> | null)
      : null
  return (
    error instanceof Error &&
    error.name === 'CodexAppServerHandshakeExitUnprovenError' &&
    connection !== null &&
    typeof connection.close === 'function'
  )
}
