import { SessionNotFoundError } from './daemon-errors'
import type { Session } from './session'

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
