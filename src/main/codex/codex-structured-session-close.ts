import type { CodexSession, CodexStructuredSessionEvent } from './codex-structured-session-state'

export async function closeCodexPublishedSession(
  sessions: Map<string, CodexSession>,
  sessionId: string,
  onEvent?: (event: CodexStructuredSessionEvent) => void
): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) {
    return
  }
  sessions.delete(sessionId)
  session.prompts.clear()
  const event: CodexStructuredSessionEvent = {
    type: 'ended',
    sessionId,
    reason: 'codex session closed'
  }
  session.translator?.handle(event)
  onEvent?.(event)
  session.translator?.flush()
  session.translator?.dispose()
  await session.connection.close()
}
