import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { RESTART_CONTINUATION_ROW_PREFIX } from '../../../../shared/agent-session/lifecycle/agent-session-stop-row-identity'
import type {
  StructuredAgentSessionContinuationHost,
  StructuredAgentSessionContinuationDeps
} from './structured-agent-session-restart-continuation'

export function restartNoteWriter(
  host: Pick<StructuredAgentSessionContinuationHost, 'sessions' | 'conversationFence' | 'now'>
): StructuredAgentSessionContinuationDeps['note'] {
  return async (sessionId, text, tone) => {
    const session = host.sessions.get(sessionId)
    const fence = host.conversationFence(sessionId)
    if (!session || fence === null) {
      return
    }
    await session.journal.appendItem(
      {
        provider: 'orca',
        clientMessageId: `${RESTART_CONTINUATION_ROW_PREFIX}${sessionId}:${host.now()}`
      },
      { kind: 'status', text, ...(tone ? { tone } : {}) },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
}
