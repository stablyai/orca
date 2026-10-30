import { hasCompleteBlockingRequests } from '../../../src/shared/agent-session-current-requests'
import { projectMobileStructuredChatSession } from './mobile-structured-session-projection'
import { authoritativeAsyncQuestion } from '../../../src/shared/agent-session-current-requests'
import { asyncQuestionSourceScope as questionSourceScope } from '../../../src/shared/native-chat/input/native-chat-ask'
import { useCallback, useMemo, useRef } from 'react'
import { encodeNativeChatTranscriptIdentity } from '../../../src/shared/native-chat/transcript/native-chat-transcript-retention'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import {
  projectStructuredQuestionMessages,
  structuredQuestionTranscript
} from '../../../src/shared/structured-agent-question-projection'
import { withNativeChatCutTurnNotices } from '../../../src/shared/native-chat/transcript/native-chat-cut-turn-notice'
import { agentSessionTranscriptRows } from '../../../src/shared/agent-session-context-clear'
import { tuiAgentDisplayName } from '../../../src/shared/tui-agent-display-names'
import { isStructuredAgentSessionMainAgentWorking } from '../../../src/shared/structured-agent-session-main-agent-working'
import {
  runningStructuredAgentSessionTurnId,
  structuredAgentSessionHostSaysWorking,
  structuredAgentSessionQueueSendsNext
} from '../../../src/shared/structured-agent-session-live-turn'
import { useMobileStructuredActionablePrompts } from './mobile-structured-actionable-prompt'
import {
  projectStructuredPermission,
  projectStructuredQuestion
} from './mobile-structured-agent-prompts'
import type {
  MobileStructuredAgentSessionArgs,
  StructuredMobileSession
} from './mobile-structured-agent-session-contract'
import type { MobileNativeChatVisualSource } from './native-chat/visual/mobile-native-chat-visual-read'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'
import { useMobileStructuredStopPress } from './use-mobile-structured-stop-press'
import { useMobileStructuredSessionHostStopping } from './use-mobile-structured-session-host-stopping'
import { useMobileStructuredPromptResponses } from './use-mobile-structured-prompt-responses'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import { useMobileStructuredSessionOptionStamp } from './use-mobile-structured-session-option-stamp'
import { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'
import {
  requestMobileMessageQuestionCancel,
  pendingStructuredPromptIdentity,
  requestMobileStructuredAgentSessionCancel
} from './mobile-structured-agent-session-cancel'
import { useMobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import { useMobileStructuredSendWithOutcome } from './use-mobile-structured-send-with-outcome'
import { useMobileStructuredQueuedMessageControls } from './use-mobile-structured-queued-message-controls'
import { useMobileStructuredBackgroundTasks } from './use-mobile-structured-background-tasks'
import { useMobileStructuredSends } from './use-mobile-structured-sends'
import { useMobileNativeChatQueueFollowUps } from './use-mobile-native-chat-queue-follow-ups'
import { useMobileStructuredStopOffer } from './use-mobile-structured-stop-offer'
import { useMobileStructuredTurnIndicator } from './use-mobile-structured-turn-indicator'

export function useMobileStructuredAgentSession(
  args: MobileStructuredAgentSessionArgs
): StructuredMobileSession {
  const {
    agent,
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
  const queueFollowUps = useMobileNativeChatQueueFollowUps(client, connected && enabled, sessionId)
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
  const turnId = runningStructuredAgentSessionTurnId(state)
  const options = useMobileStructuredAgentOptions({
    agent,
    client,
    sessionId,
    enabled,
    fence: state.fence,
    mutate,
    optionStamp,
    turnId,
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
  const turnTiming = useMobileStructuredAgentTurnTiming(
    { ...state, items: transcriptItems },
    turnId
  )
  const isWorking = structuredAgentSessionHostSaysWorking(state.working, () =>
    isStructuredAgentSessionMainAgentWorking(turnId, state.submissions, state.fence)
  )
  const queueSendsNext = structuredAgentSessionQueueSendsNext(state.nextQueuedMessageId, isWorking)
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
  const { canStop, sendsOut } = useMobileStructuredStopOffer({
    sessionKey,
    turnId,
    isWorking,
    stopsConversation: hostStopsConversation === true
  })
  const turnIndicator = useMobileStructuredTurnIndicator({
    state,
    turnId,
    isWorking,
    canStop,
    hostStopping,
    stopPressed: stopPress.pressed,
    queueCapable,
    queueFollowUps
  })
  const { stopping } = turnIndicator
  const sendWithOutcome = useMobileStructuredSendWithOutcome({
    agent,
    client,
    sessionId,
    enabled,
    queueCapable,
    queueFollowUps,
    commandsWait,
    stateRef,
    stopping,
    accept: sends.accept,
    hold: sends.hold,
    commandPending: commandPendingRef,
    sendsOut,
    controller: sendController,
    sessionCommands: args.sessionCommands,
    onSendError,
    queueSendsNext,
    sendOptions: hostSupport?.sendOptions === true ? options.sendSelection : undefined,
    takesSkills: hostSupport?.sendSkills === true
  })
  const { epoch } = state
  const [approvalPrompt, questionPrompt] = useMobileStructuredActionablePrompts(state)
  const commandRefusalCauses = useMemo(
    () => ({
      working: turnId !== null || queueSendsNext,
      prompt: approvalPrompt !== null || questionPrompt !== null
    }),
    [approvalPrompt, questionPrompt, queueSendsNext, turnId]
  )
  const queued = useMobileStructuredQueuedMessageControls({
    ...args,
    appendComposerText: args.appendComposerText,
    sessionKey,
    agentName: agent ? (tuiAgentDisplayName(agent) ?? agent) : undefined,
    journalItems: state.items,
    queuedMessages,
    queuePause,
    submissions: state.submissions,
    agentWorking: isWorking,
    imagesCapable: hostSupport?.queuedMessageImageEdit === true,
    skillsCapable: hostSupport?.queuedMessageSkillsEdit === true,
    reorderCapable: hostSupport?.queuedMessageReorder === true,
    editCapable: hostSupport ? hostSupport.queuedMessageEdit === true : null,
    chatActive: enabled,
    enabled: enabled && connected,
    mutate,
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
    asyncQuestion: authoritativeAsyncQuestion(state),
    visualSource,
    asyncQuestionSourceScope: questionSourceScope({ kind: 'journal', agent, sessionId, epoch }),
    imagePreviewsByMessageId: sends.imagePreviewsByMessageId,
    session: {
      ...projectMobileStructuredChatSession({
        state,
        connected,
        messages,
        olderPages,
        loadEarlier
      }),
      cancelMessageQuestions: (ids) => requestMobileMessageQuestionCancel(client, sessionId, ids)
    },
    isWorking: isWorking || queueSendsNext,
    canStop,
    turnId,
    turnIndicator,
    ...turnTiming,
    sendWithOutcome,
    cancel: () => void stopPress.track(() => requestCancel()),
    cancelPrompt: (prompt?: { itemId: string; expectedRevision: number }) =>
      requestCancel(prompt ?? pendingStructuredPromptIdentity(stateRef.current)),
    receipts: structuredQuestionTranscript(transcriptItems).receipts,
    actionablePromptIds: state.actionablePromptIds,
    promptsReady: !state.requestMarker || (connected && hasCompleteBlockingRequests(state)),
    permission: projectStructuredPermission(approvalPrompt),
    question: projectStructuredQuestion(questionPrompt),
    respondPermission,
    respondQuestion,
    queued,
    commandRefusalCauses,
    backgroundTasks
  }
}
