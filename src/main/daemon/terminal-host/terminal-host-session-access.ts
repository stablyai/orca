import { SessionNotFoundError, TerminalAttachCanceledError } from '../protocol/daemon-errors'
import type { Session } from '../sessions/session'

export function getAliveTerminalHostSession(
  sessions: ReadonlyMap<string, Session>,
  sessionId: string
): Session {
  const session = sessions.get(sessionId)
  if (!session || !session.isAlive) {
    throw new SessionNotFoundError(sessionId)
  }
  return session
}

export function getInspectableTerminalHostSession(
  sessions: ReadonlyMap<string, Session>,
  retired: ReadonlyMap<string, { incarnationId: string; expiresAt: number }>,
  sessionId: string,
  expectedIncarnationId?: string
): Session | null {
  const session = sessions.get(sessionId)
  if (
    (!session || !session.isAlive) &&
    !(
      (retired.get(sessionId)?.expiresAt ?? 0) > Date.now() &&
      expectedIncarnationId === retired.get(sessionId)?.incarnationId
    )
  ) {
    throw new SessionNotFoundError(sessionId)
  }
  return session ?? null
}

export function assertTerminalHostCreateAllowed(
  creationFenced: boolean,
  opts: { sessionId: string; isCanceled?: () => boolean }
): void {
  if (creationFenced) {
    throw new Error('Terminal host is shutting down')
  }
  if (opts.isCanceled?.()) {
    throw new TerminalAttachCanceledError(opts.sessionId)
  }
}
