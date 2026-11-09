import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  agentSessionContextClearOutstanding,
  agentSessionTranscriptRows,
  latestAgentSessionContextClearSequence
} from '../../../src/shared/agent-session/agent-session-context-clear'
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

/** The chat's transcript rows, its messages with this phone's sends in flight, and the prompts they resolved.
 * From this phone's /clear press until its divider lands, the rows drawn at the press stay hidden:
 * the host stops the old agent before it writes the divider. */
export function useMobileStructuredTranscript(
  agent: string | null,
  state: Pick<StructuredAgentSessionState, 'epoch' | 'items' | 'submissions'>,
  optimistic: Parameters<typeof projectStructuredAgentSessionMessages>[1],
  sessionKey: string
) {
  const [clearSent, setClearSent] = useState<{
    sessionKey: string
    epoch: string | null
    tail: number
  } | null>(null)
  // The newest row the last commit drew: the rows a press hides.
  const tail = state.items.at(-1)?.sequence ?? 0
  const drawnTail = useRef(tail)
  useEffect(() => {
    drawnTail.current = tail
  }, [tail])
  const onClearSent = useCallback(() => {
    const sent = { sessionKey, epoch: state.epoch, tail: drawnTail.current }
    setClearSent(sent)
    return () => setClearSent((current) => (current === sent ? null : current))
  }, [sessionKey, state.epoch])
  // A rewind's new epoch restarts sequences, so the press's rows are not in it.
  const clearSentTail =
    clearSent?.sessionKey === sessionKey && clearSent.epoch === state.epoch ? clearSent.tail : null
  const latestClear = useMemo(
    () => latestAgentSessionContextClearSequence(state.items),
    [state.items]
  )
  const clearing = agentSessionContextClearOutstanding(state.items, latestClear, clearSentTail)
  // Retire a press that hides nothing (its divider landed, or its rows left), so a later trim cannot re-arm it.
  if (clearSent?.sessionKey === sessionKey && !clearing) {
    setClearSent(null)
  }
  const floor = clearing ? clearSentTail + 1 : latestClear
  const transcriptItems = useMemo(
    () =>
      withNativeChatCutTurnNotices(agentSessionTranscriptRows(state.items, floor), {
        agentName: agent ? (tuiAgentDisplayName(agent) ?? agent) : undefined
      }),
    [agent, floor, state.items]
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
    clearing,
    onClearSent,
    transcriptItems,
    messages,
    receipts: mobileStructuredTranscript.transcript(transcriptItems).receipts
  }
}
