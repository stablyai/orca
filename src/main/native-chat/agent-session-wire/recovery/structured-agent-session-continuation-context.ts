import { projectSavedChatContextItems } from '../../conversation-context/agent-session-saved-prompt-text'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionContinuationContext } from '../../../../shared/agent-session/agent-session-wire'
import { buildAgentSessionHandoffContext } from '../../../../shared/agent-session-handoff-context'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { projectStructuredAgentSessionMessages } from '../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { formatWorkerTranscriptMessage } from '../../../../shared/worker-transcript-text'
import { toLinuxPath } from '../../../../shared/wsl-paths'
import { writeAgentSessionContextSnapshot } from '../../conversation-context/agent-session-context-snapshots'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'

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
    const context = await session.journal.reads.continuationContext()
    const record = sourceConversation()
    if (
      !record ||
      context.cursor.epoch !== input.expectedCursor.epoch ||
      context.cursor.sequence < input.expectedCursor.sequence
    ) {
      return { status: 'superseded' }
    }
    const messages = projectStructuredAgentSessionMessages(
      context.items,
      [],
      context.submissions,
      projectSavedChatContextItems
    )
    const capturedText = buildAgentSessionHandoffContext(messages)
    const text = messages.map(formatWorkerTranscriptMessage).join('\n\n')
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
