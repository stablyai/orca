import { finishJournalStepsAsync } from '../agent-session-journal/journal-reconstruction-steps'
import {
  flatMapAgentSessionSteps,
  mapAgentSessionSteps
} from '../../../shared/agent-session/agent-session-projection-steps'
import { projectSavedChatContextItems } from '../agent-session-saved-prompt-text'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionContinuationContext } from '../../../shared/agent-session/agent-session-wire'
import { agentSessionCurrentContextRowsSteps } from '../../../shared/agent-session/agent-session-context-clear'
import { buildAgentSessionHandoffContextSteps } from '../../../shared/agent-session-handoff-context'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { projectStructuredAgentSessionMessageSteps } from '../../../shared/agent-session/view/structured-agent-session-message-projection'
import { formatWorkerTranscriptMessage } from '../../../shared/worker-transcript-text'
import { toLinuxPath } from '../../../shared/wsl-paths'
import { writeAgentSessionContextSnapshot } from '../agent-session-context-snapshots'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export function continuationContextReader(
  deps: StructuredAgentSessionHostDeps,
  conversation: (id: string) => Promise<StructuredAgentSessionHostSession>,
  sessions?: ReadonlyMap<string, StructuredAgentSessionHostSession>
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
    const journal = session.journal
    const current = () => {
      const cursor = journal.cursor()
      return cursor.epoch === input.expectedCursor.epoch &&
        cursor.sequence >= input.expectedCursor.sequence &&
        (!sessions || sessions.get(input.sessionId) === session)
        ? sourceConversation()
        : null
    }
    // An epoch mismatch is a point read, never a reason to reconstruct discarded context.
    if (!current()) {
      return { status: 'superseded' }
    }
    const capture = await journal.readInOrder(async () => {
      if (!current()) {
        return null
      }
      await finishJournalStepsAsync(journal.preparePublicReadSteps())
      const snapshot = journal.snapshot()
      const context = await finishJournalStepsAsync(
        agentSessionCurrentContextRowsSteps(snapshot.items, snapshot.submissions)
      )
      const messages = await finishJournalStepsAsync(
        projectStructuredAgentSessionMessageSteps(
          context.items,
          [],
          context.submissions,
          projectSavedChatContextItems,
          function* (items) {
            return yield* flatMapAgentSessionSteps(items, (item) =>
              projectSavedChatContextItems([item])
            )
          }
        )
      )
      const capturedText = await finishJournalStepsAsync(
        buildAgentSessionHandoffContextSteps(messages)
      )
      const text = (
        await finishJournalStepsAsync(mapAgentSessionSteps(messages, formatWorkerTranscriptMessage))
      ).join('\n\n')
      const record = current()
      return record ? { record, capturedText, text } : null
    })
    if (!capture) {
      return { status: 'superseded' }
    }
    const { record, capturedText, text } = capture
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
