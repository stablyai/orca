import { projectSavedChatContextItems } from '../../conversation-context/agent-session-saved-prompt-text'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionContinuationContext } from '../../../../shared/agent-session/agent-session-wire'
import { buildAgentSessionHandoffContext } from '../../../../shared/native-chat/transcript/agent-session-handoff-context'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { projectStructuredAgentSessionMessages } from '../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { formatWorkerTranscriptMessage } from '../../../../shared/native-chat/transcript/worker-transcript-text'
import { toLinuxPath } from '../../../../shared/file-access/wsl-paths'
import { writeAgentSessionContextSnapshot } from '../../conversation-context/agent-session-context-snapshots'
import type {
  AgentSessionJournalReads,
  JournalContinuedPayload
} from '../../agent-session-journal/journal-reads'
import { JOURNAL_CONTINUED_CHUNK_BYTES } from '../../agent-session-journal/journal-sql-continuation-context'
import {
  ContinuedTranscriptMarkers,
  decodeStoredText
} from '../../conversation-context/agent-session-continued-transcript'
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
    // A large tool output or patch arrives as an excerpt; its whole text streams into the file.
    const markers = new ContinuedTranscriptMarkers()
    const items = [...context.items]
    context.continued.forEach((part, index) => {
      items[part.index] = markers.mark(items[part.index], index)
    })
    const messages = projectStructuredAgentSessionMessages(
      items,
      [],
      context.submissions,
      projectSavedChatContextItems
    )
    const continued = context.continued.length > 0
    const capturedText = buildAgentSessionHandoffContext(
      continued ? markers.excerpts(messages) : messages
    )
    const formatted = messages.map(formatWorkerTranscriptMessage)
    const text = continued ? '' : formatted.join('\n\n')
    if (!continued && !text.trim()) {
      return { status: 'current', capturedText: '' }
    }
    let path: string
    try {
      // Both outputs describe this stopping point, even if the conversation changes during the write.
      path = await writeAgentSessionContextSnapshot(
        deps.journalDatabase.stateDirectory,
        input.sessionId,
        continued
          ? markers.transcript(formatted, (index) =>
              decodeStoredText(storedChunks(session.journal.reads, context.continued[index]))
            )
          : text
      )
    } catch (error) {
      if (error instanceof ContinuedPayloadSuperseded) {
        return { status: 'superseded' }
      }
      throw error
    }
    return {
      status: 'current',
      capturedText,
      transcriptPath: record.location.wslDistro ? toLinuxPath(path) : path
    }
  }
}

class ContinuedPayloadSuperseded extends Error {}

/** One chunk at a time up to the recorded length; a revised or removed item supersedes the snapshot. */
async function* storedChunks(
  reads: Pick<AgentSessionJournalReads, 'continuationChunk'>,
  { itemId, revision, field, bytes: length }: JournalContinuedPayload
): AsyncGenerator<Uint8Array> {
  for (let offset = 1; offset <= length; offset += JOURNAL_CONTINUED_CHUNK_BYTES) {
    const bytes = await reads.continuationChunk({ itemId, revision, field, offset })
    if (!bytes?.length) {
      throw new ContinuedPayloadSuperseded()
    }
    yield bytes
  }
}
