import type { Session } from '../sessions/session'
import type { ProducerAnswer, StreamStallHandler } from '../sessions/session-producer-pause'

// Producer flow-control hints tolerate sessions that have already exited.
export function pauseSessionProducer(
  sessions: ReadonlyMap<string, Session>,
  sessionId: string,
  source?: 'stream',
  onStreamStall?: StreamStallHandler
): boolean | ProducerAnswer {
  const session = sessions.get(sessionId)
  if (!session || !session.isAlive) {
    return 'exited'
  }
  return session.pauseProducer(source, onStreamStall)
}

/** The spawn-time incarnation now holding this id; a respawn under the same id gets a new one. */
export function sessionIncarnation(
  sessions: ReadonlyMap<string, Session>,
  sessionId: string
): string | undefined {
  return sessions.get(sessionId)?.incarnationId
}

export function resumeSessionProducer(
  sessions: ReadonlyMap<string, Session>,
  sessionId: string,
  source?: 'stream'
): void {
  sessions.get(sessionId)?.resumeProducer(source)
}
