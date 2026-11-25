import { useQueuedSteerIntents } from '../../input/queued-messages/use-queued-steer-intents'
import { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'
import {
  createStructuredAgentSendingSource,
  type SubmissionReceiptSource
} from '../../../../../../src/shared/agent-session/view/structured-agent-sending-source'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  agentSessionContextClearOutstanding,
  agentSessionTranscriptRows,
  latestAgentSessionContextClearSequence
} from '../../../../../../src/shared/agent-session/conversation-context/agent-session-context-clear'
import type { StructuredAgentSessionState } from '../../../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../../src/shared/agent-session/view/structured-agent-session-message-projection'
import { pendingSendsOutsideQueuedCards } from '../../../../../../src/shared/agent-session/view/structured-agent-session-sending'
import {
  sendingQueuedMessageCards,
  steeringQueuedMessageEchoes
} from '../../../../../../src/shared/agent-session/view/structured-agent-session-sending-queued-cards'
import { createStructuredAgentSessionMessageProjection } from '../../../../../../src/shared/agent-session/view/structured-agent-session-message-stream'
import { tuiAgentDisplayName } from '../../../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { withNativeChatCutTurnNotices } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-cut-turn-notice'
import { omitNativeChatThreadGoalRows } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-thread-goal-rows'
import { createStructuredQuestionProjection } from '../../../../../../src/shared/native-chat/transcript/messages/structured-agent-question-projection'
import { projectStructuredAgentStartItem } from '../../../../../../src/shared/native-chat/transcript/messages/structured-agent-start-projection'
import {
  projectAutomationRunNotStartedItem,
  projectAutomationSavedItem,
  projectBotItemNoteItem
} from '../../../../../../src/shared/structured-automation-saved-projection'

const mobileStructuredTranscript = createStructuredQuestionProjection(
  (item) =>
    projectAutomationRunNotStartedItem(item) ??
    projectAutomationSavedItem(item) ??
    projectBotItemNoteItem(item) ??
    projectStructuredAgentStartItem(item)
)

/** The chat's transcript rows, its messages with this phone's sends in flight, and the prompts they resolved.
 * From this phone's /clear press until its divider lands, the rows drawn at the press stay hidden:
 * the host stops the old agent before it writes the divider. */
export function useMobileStructuredTranscript(
  {
    agent,
    read: { state, submissionReceipts },
    optimistic,
    sessionKey,
    turnId,
    queueSendsNext = false
  }: {
    agent: string | null
    read: {
      state: Pick<
        StructuredAgentSessionState,
        | 'epoch'
        | 'fence'
        | 'items'
        | 'submissions'
        | 'latestTurn'
        | 'working'
        | 'hostClock'
        | 'queuedMessages'
        | 'queuePause'
      >
      submissionReceipts: SubmissionReceiptSource
    }
    optimistic: readonly StructuredAgentSessionOptimisticMessage[]
    sessionKey: string
    turnId: string | null
    queueSendsNext?: boolean
  },
  isWorking: boolean,
  live = true
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
  const clearing = useMemo(
    () => agentSessionContextClearOutstanding(state.items, latestClear, clearSentTail),
    [clearSentTail, latestClear, state.items]
  )
  // Retire a press that hides nothing (its divider landed, or its rows left), so a later trim cannot re-arm it.
  if (clearSent?.sessionKey === sessionKey && !clearing) {
    setClearSent(null)
  }
  const floor = clearing && clearSentTail !== null ? clearSentTail + 1 : latestClear
  const transcriptItems = useMemo(
    () =>
      withNativeChatCutTurnNotices(agentSessionTranscriptRows(state.items, floor), {
        agentName: agent ? (tuiAgentDisplayName(agent) ?? agent) : undefined
      }),
    [agent, floor, state.items]
  )
  const projectMessages = useMemo(
    () => createStructuredAgentSessionMessageProjection(mobileStructuredTranscript.messages),
    []
  )
  const questionTranscript = useMemo(() => mobileStructuredTranscript.stream(), [])
  const heldIds = useMemo(
    () => (state.queuedMessages ?? []).map((message) => message.messageId),
    [state.queuedMessages]
  )
  const { queuedMessages, submissions, queuePause } = state
  const queuePaused = queuePause != null
  const steer = useQueuedSteerIntents(live ? sessionKey : '', state, isWorking)
  const steerIntents = steer.intents
  const queueSendsAsCards = isWorking || queueSendsNext
  const transcriptPending = useMemo(() => {
    const outside = pendingSendsOutsideQueuedCards(optimistic, heldIds, queueSendsAsCards)
    const steering = steeringQueuedMessageEchoes(queuedMessages, submissions, optimistic, {
      agentWorking: isWorking,
      queuePaused,
      steerIntents
    })
    return steering.length > 0 ? [...outside, ...steering] : outside
  }, [
    optimistic,
    heldIds,
    queueSendsAsCards,
    queuedMessages,
    submissions,
    isWorking,
    queuePaused,
    steerIntents
  ])
  const sendingCards = useMemo(
    () => sendingQueuedMessageCards(optimistic, heldIds, queueSendsAsCards, submissions),
    [optimistic, heldIds, queueSendsAsCards, submissions]
  )
  const projectedMessages = useMemo(
    () => projectMessages(transcriptItems, transcriptPending, state.submissions),
    [transcriptItems, transcriptPending, state.submissions, projectMessages]
  )
  // The goal strip on the composer shows goal state, as on desktop.
  const messages = useMemo(
    () => omitNativeChatThreadGoalRows(projectedMessages),
    [projectedMessages]
  )
  const sending = useMemo(
    () =>
      createStructuredAgentSendingSource(submissionReceipts, transcriptPending, state.submissions),
    [state.submissions, submissionReceipts, transcriptPending]
  )
  return {
    clearing,
    steer,
    onClearSent,
    timing: useMobileStructuredAgentTurnTiming(state, turnId, transcriptItems),
    messages,
    sending,
    sendingCards,
    receipts: questionTranscript(transcriptItems).receipts
  }
}
