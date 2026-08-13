import type { ClaudeSession, ClaudeStructuredSessionEvent } from './claude-structured-session-state'

export function settleClaudeDispatchWaiters(session: ClaudeSession): void {
  for (const waiter of session.dispatchWaiters.splice(0)) {
    clearTimeout(waiter.timer)
    waiter.resolve(null)
  }
}

export function settleClaudeExitedSession(session: ClaudeSession): void {
  settleClaudeDispatchWaiters(session)
  session.prompts.clear()
  session.translator?.dispose()
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
  input.sessions.delete(input.sessionId)
  settleClaudeDispatchWaiters(session)
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
    session.translator?.handle(ended)
    input.onEvent?.(ended)
    session.translator?.dispose()
    await session.connection.close()
  }
  if (persistenceError) {
    throw persistenceError
  }
}
