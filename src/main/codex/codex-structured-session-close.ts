import type { CodexSession, CodexStructuredSessionEvent } from './codex-structured-session-state'

export async function closeCodexPublishedSession(
  sessions: Map<string, CodexSession>,
  sessionId: string,
  onEvent?: (event: CodexStructuredSessionEvent) => void,
  releaseStructuredWriteHome?: (sessionId: string, isolatedHomePath: string) => Promise<void>
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
  let lifecycleError: unknown
  try {
    session.translator?.handle(event)
    onEvent?.(event)
    session.translator?.flush()
  } catch (error) {
    lifecycleError = error
  }
  session.translator?.dispose()
  try {
    await session.connection.close()
  } catch (error) {
    lifecycleError ??= error
  }
  if (session.isolatedHomePath) {
    try {
      if (!releaseStructuredWriteHome) {
        throw new Error(`structured Codex home for ${sessionId} has no release provider`)
      }
      await releaseStructuredWriteHome(sessionId, session.isolatedHomePath)
    } catch (error) {
      lifecycleError ??= error
    }
  }
  if (lifecycleError) {
    throw lifecycleError
  }
}
