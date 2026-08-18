import type { CodexSession, CodexStructuredSessionEvent } from './codex-structured-session-state'

export async function closeCodexPublishedSession(
  sessions: Map<string, CodexSession>,
  sessionId: string,
  onEvent?: (event: CodexStructuredSessionEvent) => void
): Promise<boolean> {
  const session = sessions.get(sessionId)
  if (!session) {
    return true
  }
  session.prompts.clear()
  // Keep the session indexed until the child exit is observed. A timeout or
  // failed kill must leave the live connection available for a safe retry.
  const exited = await session.connection.close()
  if (exited === false) {
    return false
  }
  sessions.delete(sessionId)
  const event: CodexStructuredSessionEvent = {
    type: 'ended',
    sessionId,
    reason: 'codex session closed'
  }
  session.translator?.handle(event)
  onEvent?.(event)
  session.translator?.flush()
  session.translator?.dispose()
  return true
}
