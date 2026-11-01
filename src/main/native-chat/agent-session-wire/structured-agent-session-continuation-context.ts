import { projectSavedChatContextItems } from '../agent-session-saved-prompt-text'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionContinuationContext } from '../../../shared/agent-session-wire'
import { agentSessionCurrentContextRows } from '../../../shared/agent-session-context-clear'
import { trimAgentSessionContext } from '../../../shared/agent-session-context-budget'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { formatWorkerTranscriptMessage } from '../../../shared/worker-transcript-text'
import { toLinuxPath } from '../../../shared/wsl-paths'
import { writeAgentSessionContextSnapshot } from '../agent-session-context-snapshots'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export function continuationContextReader(
  deps: StructuredAgentSessionHostDeps,
  conversation: (id: string) => Promise<StructuredAgentSessionHostSession>
) {
  return async (input: {
    sessionId: string
    workspaceId: string
    expectedCursor: AgentJournalCursor
  }): Promise<AgentSessionContinuationContext> => {
    const sourceConversation = () => {
      const record = deps.store.getConversation(input.sessionId)
      return record?.location.workspaceId === input.workspaceId &&
        record.location.executionHostId === LOCAL_EXECUTION_HOST_ID
        ? record
        : null
    }
    if (!sourceConversation()) {
      return { status: 'superseded' }
    }
    const session = await conversation(input.sessionId)
    const record = sourceConversation()
    const snapshot = session.journal.snapshot()
    if (
      !record ||
      snapshot.cursor.epoch !== input.expectedCursor.epoch ||
      snapshot.cursor.sequence < input.expectedCursor.sequence
    ) {
      return { status: 'superseded' }
    }
    const context = agentSessionCurrentContextRows(snapshot.items, snapshot.submissions)
    const text = projectStructuredAgentSessionMessages(
      context.items,
      [],
      context.submissions,
      projectSavedChatContextItems
    )
      .map(formatWorkerTranscriptMessage)
      .join('\n\n')
    const capturedText = trimAgentSessionContext(text, 'saved chat messages')
    if (!text.trim()) {
      return { status: 'current', capturedText: '' }
    }
    // Both outputs describe this stopping point, even if the conversation changes during the write.
    const path = await writeAgentSessionContextSnapshot(
      deps.journalDatabase.stateDirectory,
      input.sessionId,
      text
    )
    return {
      status: 'current',
      capturedText,
      transcriptPath: record.location.wslDistro ? toLinuxPath(path) : path
    }
  }
}
