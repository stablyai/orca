import type { AgentType } from '../../shared/agent-status/contracts/agent-status-types'
import type { AgentJournalCursor } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSnapshot } from '../../shared/agent-session/journal/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../shared/agent-session/view/structured-agent-session-message-projection'
import { isConfirmedNativeChatUserSubmission } from '../../shared/native-chat/native-chat-submission-evidence'
import { readNativeChatTranscriptTail } from './transcript-tail-reader'

export function structuredChatSubmissionSummary(
  snapshot: AgentJournalSnapshot,
  before: AgentJournalCursor
): { hasPriorSubmission: boolean } {
  if (snapshot.cursor.epoch !== before.epoch) {
    return { hasPriorSubmission: false }
  }
  const items = snapshot.items.filter(
    (item) =>
      item.sequence < before.sequence && item.body.kind === 'message' && item.body.role === 'user'
  )
  return {
    hasPriorSubmission: projectStructuredAgentSessionMessages(items, [], snapshot.submissions).some(
      isConfirmedNativeChatUserSubmission
    )
  }
}

export async function ptyChatSubmissionSummary(
  args: {
    agent: AgentType
    sessionId: string
    transcriptPath?: string
    anchorId: string
  },
  signal?: AbortSignal
): Promise<{ hasPriorSubmission: boolean }> {
  let beforeOffset: number | undefined
  let anchored = false
  for (;;) {
    signal?.throwIfAborted()
    const page = await readNativeChatTranscriptTail(
      {
        ...args,
        limit: 500,
        beforeOffset,
        sourceOrder: true
      },
      signal
    )
    signal?.throwIfAborted()
    if ('error' in page) {
      return { hasPriorSubmission: false }
    }
    let messages = page.messages
    if (!anchored) {
      const index = messages.findIndex((message) => message.id === args.anchorId)
      if (index !== -1) {
        anchored = true
        messages = messages.slice(0, index + 1)
      }
    }
    if (anchored && messages.some(isConfirmedNativeChatUserSubmission)) {
      return { hasPriorSubmission: true }
    }
    if (
      !page.hasMore ||
      !Number.isFinite(page.beforeOffset) ||
      (beforeOffset !== undefined && page.beforeOffset >= beforeOffset)
    ) {
      return { hasPriorSubmission: false }
    }
    beforeOffset = page.beforeOffset
  }
}
