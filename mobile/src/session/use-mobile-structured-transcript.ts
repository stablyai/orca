import { useMemo } from 'react'
import { agentSessionTranscriptRows } from '../../../src/shared/agent-session/agent-session-context-clear'
import type { StructuredAgentSessionState } from '../../../src/shared/agent-session/structured-agent-session-reducer'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/agent-session/view/structured-agent-session-message-projection'
import { tuiAgentDisplayName } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { withNativeChatCutTurnNotices } from '../../../src/shared/native-chat/transcript/native-chat-cut-turn-notice'
import { omitNativeChatThreadGoalRows } from '../../../src/shared/native-chat/transcript/native-chat-thread-goal-rows'
import { createStructuredQuestionProjection } from '../../../src/shared/structured-agent-question-projection'
import { projectStructuredAgentStartItem } from '../../../src/shared/structured-agent-start-projection'

const mobileStructuredTranscript = createStructuredQuestionProjection(
  projectStructuredAgentStartItem
)

/** The chat's transcript rows, its messages with this phone's sends in flight, and the prompts they resolved. */
export function useMobileStructuredTranscript(
  agent: string | null,
  state: Pick<StructuredAgentSessionState, 'items' | 'submissions'>,
  optimistic: Parameters<typeof projectStructuredAgentSessionMessages>[1]
) {
  const transcriptItems = useMemo(
    () =>
      withNativeChatCutTurnNotices(agentSessionTranscriptRows(state.items), {
        agentName: agent ? (tuiAgentDisplayName(agent) ?? agent) : undefined
      }),
    [agent, state.items]
  )
  const messages = useMemo(
    () =>
      // The goal strip on the composer shows goal state, as on desktop.
      omitNativeChatThreadGoalRows(
        projectStructuredAgentSessionMessages(
          transcriptItems,
          optimistic,
          state.submissions,
          mobileStructuredTranscript.messages
        )
      ),
    [transcriptItems, optimistic, state.submissions]
  )
  return {
    transcriptItems,
    messages,
    receipts: mobileStructuredTranscript.transcript(transcriptItems).receipts
  }
}
