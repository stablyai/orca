import { useCallback, useMemo, useRef } from 'react'
import { encodeNativeChatTranscriptIdentity } from '../../../src/shared/native-chat-transcript-retention'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import {
  projectStructuredQuestionMessages,
  structuredQuestionTranscript
} from '../../../src/shared/structured-agent-question-projection'
import { withNativeChatCutTurnNotices } from '../../../src/shared/native-chat-cut-turn-notice'
import { agentSessionTranscriptRows } from '../../../src/shared/agent-session-context-clear'
import { tuiAgentDisplayName } from '../../../src/shared/tui-agent-display-names'
import { isStructuredAgentSessionMainAgentWorking } from '../../../src/shared/structured-agent-session-main-agent-working'
import { isFinalAgentSessionReadRefusal } from '../../../src/shared/structured-agent-session-read-refusal'
import {
  isStructuredAgentSessionThinking,
  runningStructuredAgentSessionTurnId,
  structuredAgentSessionHostSaysWorking
} from '../../../src/shared/structured-agent-session-live-turn'
import { selectStructuredAgentTurnActivity } from '../../../src/shared/native-chat-turn-activity'
import {
  actionableStructuredApproval,
  actionableStructuredQuestion
} from './mobile-structured-actionable-prompt'
import {
  projectStructuredPermission,
  projectStructuredQuestion
} from './mobile-structured-agent-prompts'
import type {
  MobileStructuredAgentSessionArgs,
  StructuredMobileSession
} from './mobile-structured-agent-session-contract'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'
import { useMobileStructuredStopPress } from './use-mobile-structured-stop-press'
import { useMobileStructuredSessionHostStopping } from './use-mobile-structured-session-host-stopping'
import { useMobileStructuredPromptResponses } from './use-mobile-structured-prompt-responses'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import { useMobileStructuredSessionOptionStamp } from './use-mobile-structured-session-option-stamp'
import { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'
import {
  pendingStructuredPromptIdentity,
  requestMobileStructuredAgentSessionCancel
} from './mobile-structured-agent-session-cancel'
import { useMobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import { agentStopDisplayStatus } from '../../../src/shared/agent-stop-display-status'
import {
  mobileStructuredSendQueues,
  useMobileStructuredSendWithOutcome
} from './use-mobile-structured-send-with-outcome'
import { useMobileStructuredQueuedMessageControls } from './use-mobile-structured-queued-message-controls'
import { useMobileStructuredBackgroundTasks } from './use-mobile-structured-background-tasks'
import { useMobileStructuredSends } from './use-mobile-structured-sends'

export function useMobileStructuredAgentSession(
  args: MobileStructuredAgentSessionArgs
): StructuredMobileSession {
  const {
    agent,
    appendComposerText,
    client,
    connected,
    sessionId,
    sourceIdentity = '',
    enabled,
    onActionResolved,
    onSendError,
    hostSupport
  } = args
  // Gate queueing by capability while accepting published cards from every host.
  const queueCapable = hostSupport?.queuedMessages === true
  const commandsWait = queueCapable && hostSupport?.queuedCommands === true
  const promptCancelSupported = hostSupport?.promptCancel ?? null
  const hostAnswersRepeatedStops = hostSupport?.quietRepeatedStop ?? null
  const hostStopsConversation = hostSupport?.conversationStop ?? null
  const sessionKey = encodeNativeChatTranscriptIdentity([sourceIdentity, agent, sessionId])
  const commandPendingRef = useRef(false)
  // Legacy hosts must join repeated Stop while the first turn cancel remains pending.
  const inFlightStopsRef = useRef(new Map<string, Promise<boolean>>())
  const stateArgs = { client, sessionId, sessionKey, enabled, connected }
  const { state, stateRef, queuedMessages, queuePause, olderPages, loadEarlier } =
    useMobileStructuredAgentState(stateArgs)

  const mutate = useMobileStructuredAgentMutate({
    client,
    sessionId,
    enabled,
    stateRef,
    onSendError,
    ...(agent ? { agentName: tuiAgentDisplayName(agent) ?? agent } : {})
  })

  const optionStamp = useMobileStructuredSessionOptionStamp({
    client,
    sessionId,
    enabled: enabled && connected && hostSupport?.statusFeed === true
  })
  const options = useMobileStructuredAgentOptions({
    agent,
    client,
    sessionId,
    enabled,
    fence: state.fence,
    mutate,
    optionStamp,
    hostSupport
  })
  const { conversationCommands, invokeStructuredOption, optionSnapshot, setStructuredOption } =
    options
  const sendController = useMemo(
    () => ({
      snapshot: optionSnapshot,
      setOption: setStructuredOption,
      invokeAction: invokeStructuredOption,
      conversationCommands
    }),
    [conversationCommands, invokeStructuredOption, optionSnapshot, setStructuredOption]
  )

  const { respondPermission, respondQuestion } = useMobileStructuredPromptResponses({
    stateRef,
    mutate,
    questionAnswersSupported: hostSupport?.questionAnswers ?? null,
    onSendError
  })

  const transcriptItems = useMemo(
    () =>
      withNativeChatCutTurnNotices(agentSessionTranscriptRows(state.items), {
        agentName: agent ? (tuiAgentDisplayName(agent) ?? agent) : undefined
      }),
    [agent, state.items]
  )
  const sends = useMobileStructuredSends({
    sessionKey,
    cursor: state.cursor,
    submissions: state.submissions,
    queuedMessages,
    onSendError
  })
  const messages = useMemo(
    () =>
      projectStructuredAgentSessionMessages(
        transcriptItems,
        sends.optimistic,
        state.submissions,
        projectStructuredQuestionMessages
      ),
    [transcriptItems, sends.optimistic, state.submissions]
  )
  const turnId = runningStructuredAgentSessionTurnId(state)
  const turnTiming = useMobileStructuredAgentTurnTiming(
    { ...state, items: transcriptItems },
    turnId
  )
  const activityText =
    selectStructuredAgentTurnActivity(state.items, turnId, state.activity)?.text ?? null
  const thinking = isStructuredAgentSessionThinking(state)
  const isWorking = structuredAgentSessionHostSaysWorking(state.working, () =>
    isStructuredAgentSessionMainAgentWorking(turnId, state.submissions, state.fence)
  )
  const backgroundTasks = useMobileStructuredBackgroundTasks({
    sessionKey,
    state,
    turnId,
    connected,
    mutate
  })
  const hostStopping = useMobileStructuredSessionHostStopping({
    client,
    sessionId,
    enabled: enabled && connected && hostSupport?.statusFeed === true
  })
  const stopPress = useMobileStructuredStopPress(sessionKey)
  const stopping =
    agentStopDisplayStatus({
      working: isWorking,
      hostStopping,
      stopPressed: stopPress.pressed
    }) === 'stopping'
  const stopRequestInFlight = isWorking && stopPress.pressed
  const sendWithOutcome = useMobileStructuredSendWithOutcome({
    agent,
    client,
    sessionId,
    enabled,
    queueCapable,
    commandsWait,
    stateRef,
    stopping,
    accept: sends.accept,
    hold: sends.hold,
    commandPending: commandPendingRef,
    controller: sendController,
    sessionCommands: args.sessionCommands,
    onSendError,
    sendOptions: hostSupport?.sendOptions === true ? options.sendSelection : undefined
  })
  const turnIndicator = useMemo(
    () => ({
      thinking,
      activityText,
      stopping,
      stopRequestInFlight,
      ...(stopping
        ? {
            afterStop: mobileStructuredSendQueues(queueCapable, state)
              ? ('queue' as const)
              : ('send' as const)
          }
        : {})
    }),
    [thinking, activityText, stopping, stopRequestInFlight, queueCapable, state]
  )
  const { items, currentRequests, actionablePromptIds, status } = state
  // Prefer host actionability: ended-agent prompts must receive no answer.
  const [approvalPrompt, questionPrompt] = useMemo(() => {
    const prompts = { items, currentRequests, actionablePromptIds }
    return [actionableStructuredApproval(prompts), actionableStructuredQuestion(prompts)] as const
  }, [items, currentRequests, actionablePromptIds])
  const commandRefusalCauses = useMemo(
    () => ({
      working: turnId !== null,
      prompt: approvalPrompt !== null || questionPrompt !== null
    }),
    [approvalPrompt, questionPrompt, turnId]
  )
  const queued = useMobileStructuredQueuedMessageControls({
    sessionKey,
    agentName: agent ? (tuiAgentDisplayName(agent) ?? agent) : undefined,
    journalItems: state.items,
    queuedMessages,
    queuePause,
    submissions: state.submissions,
    agentWorking: isWorking,
    client,
    sessionId,
    editCapable: hostSupport ? hostSupport.queuedMessageEdit === true : null,
    chatActive: enabled,
    enabled: enabled && connected,
    mutate,
    appendComposerText,
    onSendError,
    ...(onActionResolved ? { onActionResolved } : {})
  })
  // Stop preserves host-held cards under queue pause; only a later user action resumes them.
  const requestCancel = useCallback(
    (prompt?: { itemId: string; expectedRevision: number }): Promise<boolean> =>
      requestMobileStructuredAgentSessionCancel({
        client,
        enabled,
        hostAnswersRepeatedStops,
        hostStopsConversation,
        inFlight: inFlightStopsRef.current,
        onSendError,
        prompt,
        promptCancelSupported,
        sessionId,
        stateRef
      }),
    [
      client,
      enabled,
      hostAnswersRepeatedStops,
      hostStopsConversation,
      onSendError,
      promptCancelSupported,
      sessionId,
      stateRef
    ]
  )

  const visualSource = useMemo<MobileNativeChatVisualSource | null>(
    () => (client && sessionId ? { client, sessionId } : null),
    [client, sessionId]
  )

  return {
    ...options,
    visualSource,
    imagePreviewsByMessageId: sends.imagePreviewsByMessageId,
    session: {
      messages,
      status,
      transcriptLoading: status === 'loading',
      error: state.error,
      readFailedFinally: status === 'error' && isFinalAgentSessionReadRefusal(state.readRefusal),
      hasMore: state.hasOlder && olderPages !== 'unavailable',
      loadingEarlier: olderPages === 'loading',
      olderPages,
      loadEarlier
    },
    isWorking,
    turnId,
    turnIndicator,
    ...turnTiming,
    sendWithOutcome,
    cancel: () => void stopPress.track(() => requestCancel()),
    cancelPrompt: (prompt?: { itemId: string; expectedRevision: number }) =>
      requestCancel(prompt ?? pendingStructuredPromptIdentity(stateRef.current)),
    receipts: structuredQuestionTranscript(transcriptItems).receipts,
    actionablePromptIds: state.actionablePromptIds,
    permission: projectStructuredPermission(approvalPrompt),
    question: projectStructuredQuestion(questionPrompt),
    respondPermission,
    respondQuestion,
    queued,
    commandRefusalCauses,
    backgroundTasks
  }
}
