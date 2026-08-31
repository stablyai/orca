import type { ClaudeSession, ClaudeStructuredSessionEvent } from './claude-structured-session-state'

export function settleClaudeExitedSession(session: ClaudeSession): void {
  session.prompts.clear()
  session.translator?.dispose()
}

export function markClaudeSessionTerminal(session: ClaudeSession): void {
  session.dispatchFenced = true
  session.terminal.close()
}

export async function closeClaudePublishedSession(input: {
  sessions: Map<string, ClaudeSession>
  sessionId: string
  persistHandle?: (handle: {
    sessionId: string
    providerSessionId: string
    leafUuid: string | null
    fence: number
  }) => Promise<void>
  onEvent?: (event: ClaudeStructuredSessionEvent) => void
}): Promise<void> {
  const session = input.sessions.get(input.sessionId)
  if (!session) {
    return
  }
  markClaudeSessionTerminal(session)
  input.sessions.delete(input.sessionId)
  session.translator?.handle({
    type: 'ended',
    sessionId: input.sessionId,
    reason: 'claude session closed'
  })
  const pending = session.prompts.clear()
  await Promise.allSettled(
    pending.map((prompt) =>
      session.connection.respond(prompt.requestId, {
        behavior: 'deny',
        message: 'Structured Claude session closed.',
        interrupt: true,
        toolUseID: prompt.toolUseId
      })
    )
  )
  let persistenceError: unknown
  try {
    await input.persistHandle?.({
      sessionId: input.sessionId,
      providerSessionId: session.providerSessionId,
      leafUuid: session.leafUuid,
      fence: session.fence
    })
    input.onEvent?.({
      type: 'handle',
      sessionId: input.sessionId,
      providerSessionId: session.providerSessionId,
      leafUuid: session.leafUuid,
      fence: session.fence
    })
  } catch (error) {
    persistenceError = error
  } finally {
    const ended = {
      type: 'ended',
      sessionId: input.sessionId,
      reason: 'claude session closed'
    } as const
    input.onEvent?.(ended)
    session.translator?.dispose()
    await session.connection.close()
  }
  if (persistenceError) {
    throw persistenceError
  }
}
