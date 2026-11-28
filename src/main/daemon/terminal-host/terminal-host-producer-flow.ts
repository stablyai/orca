import type { Session } from '../sessions/session'
import type { StreamStallHandler } from '../sessions/session-producer-pause'

// Producer flow-control hints tolerate sessions that have already exited.
export function pauseSessionProducer(
  sessions: ReadonlyMap<string, Session>,
  sessionId: string,
  source?: 'stream',
  onStreamStall?: StreamStallHandler
): boolean | 'exited' {
  const session = sessions.get(sessionId)
  if (!session || !session.isAlive) {
    return 'exited'
  }
  return session.pauseProducer(source, onStreamStall)
}

export function resumeSessionProducer(
  sessions: ReadonlyMap<string, Session>,
  sessionId: string,
  source?: 'stream'
): void {
  sessions.get(sessionId)?.resumeProducer(source)
}
