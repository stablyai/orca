import type { CodexSession } from './codex-structured-session-state'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'

/** Codex's own approval of a denied action: its model sees it as the person's, and still reviews the retry. */
export function approveCodexAutoReviewDenial(
  sessions: Map<string, CodexSession>
): NonNullable<StructuredAgentSessionAdapter['approveAutoReviewDenial']> {
  return async ({ sessionId, threadId, event }) => {
    const session = sessions.get(sessionId)
    if (!session || session.ended || session.connection.closed || session.threadId !== threadId) {
      return false
    }
    await session.connection.request('thread/approveGuardianDeniedAction', { threadId, event })
    return true
  }
}
