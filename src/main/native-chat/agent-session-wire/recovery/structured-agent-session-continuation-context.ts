import { randomUUID } from 'node:crypto'
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
  JournalContinuationContext
} from '../../agent-session-journal/journal-reads'
import {
  JOURNAL_CONTINUED_CHUNK_CHARS,
  JOURNAL_CONTINUED_FIRST_OFFSET
} from '../../agent-session-journal/journal-sql-continuation-context'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
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
    // A large tool output or patch arrives as its head; a marker places the rest, streamed in chunks.
    const marker = `\u0000orca-continued:${randomUUID()}:`
    const markedItems = [...context.items]
    context.continued.forEach((part, index) => {
      markedItems[part.index] = withHeadSuffix(markedItems[part.index], `${marker}${index}\u0000`)
    })
    const messages = projectStructuredAgentSessionMessages(
      markedItems,
      [],
      context.submissions,
      projectSavedChatContextItems
    )
    const markers = new RegExp(`${marker}(\\d+)\u0000`, 'g')
    const capturedText = buildAgentSessionHandoffContext(
      context.continued.length ? withoutMarkers(messages, markers) : messages
    )
    const text = messages.map(formatWorkerTranscriptMessage).join('\n\n')
    if (!text.trim()) {
      return { status: 'current', capturedText: '' }
    }
    let path: string
    try {
      // Both outputs describe this stopping point, even if the conversation changes during the write.
      path = await writeAgentSessionContextSnapshot(
        deps.journalDatabase.stateDirectory,
        input.sessionId,
        context.continued.length
          ? splicedTranscript(text, markers, context, session.journal.reads)
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

function withHeadSuffix(item: AgentJournalRenderItem, suffix: string): AgentJournalRenderItem {
  const { body } = item
  if (body.kind === 'diff') {
    return { ...item, body: { ...body, patch: { ...body.patch, head: body.patch.head + suffix } } }
  }
  if (body.kind === 'tool-call' && body.output) {
    return {
      ...item,
      body: { ...body, output: { ...body.output, head: body.output.head + suffix } }
    }
  }
  return item
}

function withoutMarkers(messages: NativeChatMessage[], markers: RegExp): NativeChatMessage[] {
  return messages.map((message) => ({
    ...message,
    blocks: message.blocks.map((block) =>
      block.type === 'tool-result' ? { ...block, output: block.output.replace(markers, '') } : block
    )
  }))
}

/** Holds one chunk at a time; a revised or removed item supersedes the whole snapshot. */
async function* splicedTranscript(
  text: string,
  markers: RegExp,
  context: JournalContinuationContext,
  reads: Pick<AgentSessionJournalReads, 'continuationChunk'>
): AsyncGenerator<string> {
  let end = 0
  for (const match of text.matchAll(markers)) {
    yield text.slice(end, match.index)
    const { itemId, revision, field } = context.continued[Number(match[1])]
    for (let offset = JOURNAL_CONTINUED_FIRST_OFFSET; ; offset += JOURNAL_CONTINUED_CHUNK_CHARS) {
      const chunk = await reads.continuationChunk({ itemId, revision, field, offset })
      if (chunk === null) {
        throw new ContinuedPayloadSuperseded()
      }
      if (!chunk) {
        break
      }
      yield chunk
    }
    end = match.index + match[0].length
  }
  yield text.slice(end)
}
