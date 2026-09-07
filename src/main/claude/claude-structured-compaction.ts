import type { ClaudeSession, ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import type { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
export function compactClaudeSession(
  session: ClaudeSession,
  compactions: StructuredSessionCompaction,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['compact']>>[0],
  timeoutMs: number
): Promise<{ error?: string }> {
  return compactions.run(
    input.sessionId,
    session.providerSessionId,
    async () => {
      const result = await dispatchClaudeTurn(
        session,
        {
          clientMessageId: `compact-${input.fence}`,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '/compact' }] }
        },
        timeoutMs
      )
      if (result.state === 'rejected') {
        return { error: result.reason }
      }
      return undefined
    },
    input.onLateResult,
    input.turnId
  )
}

export function observeClaudeCompaction(
  compactions: StructuredSessionCompaction,
  event: ClaudeStructuredSessionEvent,
  translator: ClaudeSession['translator'] | undefined
): void {
  if (!isClaudeCompactionContent(compactions, event)) {
    translator?.handle(event)
  }
  if (event.type === 'message') {
    compactions.claude(event.sessionId, event.message)
  }
  if (event.type === 'ended') {
    compactions.ended(event.sessionId)
  }
}

export function isClaudeCompactionContent(
  compactions: StructuredSessionCompaction,
  event: ClaudeStructuredSessionEvent
): boolean {
  return (
    event.type === 'message' &&
    compactions.hasPending(event.sessionId) &&
    ['user', 'assistant', 'stream_event'].includes(String(event.message.type))
  )
}
