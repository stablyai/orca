import { stopAgentSessionProviderRoot } from '../../../native-chat/agent-session-wire/termination/structured-agent-session-provider-exit-proof'
import type { AgentSessionStartEndings } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import type { ZcodeStructuredSession } from './zcode-structured-session'

// Child retirement: requested closes prove the exit before ownership drops, forced closes settle
// the journal first, and a re-acquire arriving a moment early waits out the retirement.

/** Closes a child and drops ownership only once the exit is proven. */
export async function closeZcodeSession(
  sessions: Map<string, ZcodeStructuredSession>,
  sessionId: string
): Promise<boolean> {
  const session = sessions.get(sessionId)
  if (!session) {
    return true
  }
  const stopped = await session.close().catch(() => false)
  if (stopped) {
    sessions.delete(sessionId)
  }
  return stopped
}

/** Sink-failure teardown: settle the journal closed, then stop the child like a requested close. */
export async function forceCloseZcodeSession(
  sessions: Map<string, ZcodeStructuredSession>,
  sessionId: string,
  reason: string
): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) {
    return
  }
  session.failureClose = reason
  session.markJournalClosed(reason)
  session.markEnded(Date.now())
  const stopped = await session.close().catch(() => false)
  if (stopped) {
    sessions.delete(sessionId)
  }
}

/**
 * Ownership survives until close proves the child exited; release then reports honestly. The
 * returned retirement promise lets a re-acquire wait instead of failing a moment too early.
 */
export function acknowledgeZcodeSessionRelease(
  sessions: Map<string, ZcodeStructuredSession>,
  sessionId: string
): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session?.ended) {
    return Promise.resolve()
  }
  return Promise.resolve(
    session
      .close()
      .catch(() => false)
      .then((stopped) => {
        if (stopped) {
          sessions.delete(sessionId)
        }
      })
  )
}

export async function closeAllZcodeSessions(
  sessions: Map<string, ZcodeStructuredSession>,
  endings: AgentSessionStartEndings,
  closeSession: (sessionId: string) => Promise<boolean>
): Promise<void> {
  endings.clear()
  await Promise.all(
    [...sessions.keys()].map((sessionId) =>
      stopAgentSessionProviderRoot(() => closeSession(sessionId))
    )
  )
}
