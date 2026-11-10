import { asyncQuestionSourceScope as questionSourceScope } from '../../../../../src/shared/native-chat/input/native-chat-ask'
import { structuredChatTranscriptIdentity } from '../transcript/mobile-native-chat-transcript-store'
import { useMemo, useRef } from 'react'
import { tuiAgentDisplayName } from '../../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { mobileStructuredAgentSessionWorking } from './mobile-structured-agent-session-working'
import { isFinalAgentSessionReadRefusal } from '../../../../../src/shared/agent-session/failures/structured-agent-session-read-refusal'
import {
  runningStructuredAgentSessionTurnId,
  structuredAgentSessionQueueSendsNext
} from '../../../../../src/shared/agent-session/view/structured-agent-session-live-turn'
import {
  actionableStructuredApproval,
  actionableStructuredQuestion
} from '../input/mobile-structured-actionable-prompt'
import {
  projectStructuredPermission,
  projectStructuredQuestion
} from '../input/mobile-structured-agent-prompts'
import type {
  MobileStructuredAgentSessionArgs,
  StructuredMobileSession
} from './mobile-structured-agent-session-contract'
import type { MobileNativeChatVisualSource } from '../visual/mobile-native-chat-visual-read'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'
import { useMobileStructuredStopPress } from '../composer/use-mobile-structured-stop-press'
import { useMobileStructuredSessionHostStopping } from './use-mobile-structured-session-host-stopping'
import { useMobileStructuredPromptResponses } from '../input/use-mobile-structured-prompt-responses'
import { useMobileStructuredAgentOptions } from '../input/use-mobile-structured-agent-options'
import { useHostModelCatalogCache } from '../input/mobile-host-model-catalog-query'
import { useMobileStructuredCommandController } from '../composer/use-mobile-structured-command-controller'
import { useMobileStructuredSessionOptionStamp } from '../input/use-mobile-structured-session-option-stamp'
import { useMobileStructuredAgentTurnTiming } from '../transcript/use-mobile-structured-agent-turn-timing'
import {
  pendingStructuredPromptIdentity,
  useMobileStructuredRequestCancel
} from './mobile-structured-agent-session-cancel'
import { useMobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import { useMobileStructuredSendWithOutcome } from '../composer/use-mobile-structured-send-with-outcome'
import { useMobileStructuredQueuedMessageControls } from '../input/use-mobile-structured-queued-message-controls'
import { useMobileStructuredBackgroundTasks } from '../input/use-mobile-structured-background-tasks'
import { useMobileStructuredSends } from '../composer/use-mobile-structured-sends'
import { useMobileStructuredSendRecorded } from '../composer/mobile-structured-send-recorded-read'
import { useMobileNativeChatQueueFollowUps as useQueueFollowUps } from '../preferences/use-mobile-native-chat-queue-follow-ups'
import { useMobileStructuredStopOffer } from '../composer/use-mobile-structured-stop-offer'
import { useMobileStructuredTurnIndicator } from '../transcript/use-mobile-structured-turn-indicator'
import { useMobileStructuredContextUsage } from '../composer/use-mobile-structured-context-usage'
import { useMobileStructuredInterruptedContinue } from '../composer/use-mobile-structured-interrupted-continue'
import {
  useMobileStructuredThreadGoal,
  useMobileStructuredThreadGoalSend
} from '../input/use-mobile-structured-thread-goal'
import { useMobileStructuredTranscript } from '../transcript/use-mobile-structured-transcript'
import { useMobileStructuredAgentRewind } from './use-mobile-structured-agent-rewind'
import { useMobileNativeChatUsageLimit } from '../use-mobile-native-chat-usage-limit'

export function useMobileStructuredAgentSession(
  args: MobileStructuredAgentSessionArgs
): StructuredMobileSession {
  const {
    agent,
    client,
    hostId,
    pairedHostClient: paired,
    connected,
    sessionId,
    sourceIdentity = '',
    enabled,
    onActionResolved,
    onSendError,
    hostSupport,
    onCommandsChanged
  } = args
  // Gate queueing by capability while accepting published cards from every host.
  const queueCapable = hostSupport?.queuedMessages === true
  const commandsWait = queueCapable && hostSupport?.queuedCommands === true
  const queueFollowUps = useQueueFollowUps(client, connected && enabled, sessionId, paired, enabled)
  const hostStopsConversation = hostSupport?.conversationStop ?? null
  const sessionKey = structuredChatTranscriptIdentity(sourceIdentity, agent, sessionId)
  const commandPendingRef = useRef(false)
  const stateArgs = { client, sessionId, sessionKey, enabled, connected, onCommandsChanged }
  const { state, stateRef, queuedMessages, queuePause, olderPages, loadEarlier, savedAt } =
    useMobileStructuredAgentState(stateArgs)

  const mutate = useMobileStructuredAgentMutate({
    client,
    sessionId,
    enabled,
    stateRef,
    onSendError,
    ...(agent ? { agentName: tuiAgentDisplayName(agent) ?? agent } : {})
  })

  const turnId = runningStructuredAgentSessionTurnId(state)
  const options = useMobileStructuredAgentOptions({
    agent,
    modelCatalogCache: useHostModelCatalogCache({ hostId, client, agent, enabled }),
    client,
    sessionId,
    enabled,
    fence: state.fence,
    mutate,
    onOptionError: onSendError,
    optionStamp: useMobileStructuredSessionOptionStamp({
      client,
      sessionId,
      enabled: enabled && connected && hostSupport?.statusFeed === true
    }),
    turnId,
    hasTurn: state.latestTurn != null || state.submissions.length > 0,
    unloadedTurnRevisions: state.unloadedTurnRevisions,
    hostSupport
  })
  const sendController = useMobileStructuredCommandController(options)
  const { contextUsageSupport, ...optionFields } = options

  const { respondPermission, respondQuestion } = useMobileStructuredPromptResponses({
    stateRef,
    mutate,
    questionAnswersSupported: hostSupport?.questionAnswers ?? null,
    onSendError
  })

  const sends = useMobileStructuredSends({
    ...stateArgs,
    cursor: state.cursor,
    submissions: state.submissions,
    queuedMessages,
    onSendError,
    confirmRecorded: useMobileStructuredSendRecorded(client, sessionId, hostSupport)
  })
  const transcript = useMobileStructuredTranscript(agent, state, sends.optimistic, sessionKey)
  const { clearing, transcriptItems, messages, receipts } = transcript
  const turnTiming = useMobileStructuredAgentTurnTiming(
    { ...state, items: transcriptItems },
    turnId
  )
  const isWorking = mobileStructuredAgentSessionWorking(state)
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
    queueFollowUps,
    queueSendsNext
  })
  const goal = useMobileStructuredThreadGoal(args, state, {
    sessionKey,
    report: options.threadGoalSupport,
    turnId,
    workingStartedAt: turnTiming.workingStartedAt,
    working: isWorking || queueSendsNext,
    mutate,
    commands: sendController
  })
  const sendWithOutcomeUngated = useMobileStructuredSendWithOutcome({
    agent,
    client,
    sessionId,
    enabled,
    queueCapable,
    queueFollowUps,
    commandsWait,
    stateRef,
    stopping: turnIndicator.stopping,
    ...sends,
    commandPending: commandPendingRef,
    onClearSent: transcript.onClearSent,
    sendsOut,
    controller: goal.commands,
    sessionCommands: args.sessionCommands,
    onSendError,
    queueSendsNext,
    sendSelection: options.sendSelection,
    takesSkills: hostSupport?.sendSkills === true
  })
  const { items, currentRequests, actionablePromptIds, status, epoch } = state
  // Prefer host actionability: ended-agent prompts must receive no answer.
  const [approvalPrompt, questionPrompt] = useMemo(() => {
    const prompts = { items, currentRequests, actionablePromptIds }
    return [actionableStructuredApproval(prompts), actionableStructuredQuestion(prompts)] as const
  }, [items, currentRequests, actionablePromptIds])
  const commandRefusalCauses = useMemo(
    () => ({
      working: turnId !== null || queueSendsNext,
      prompt: approvalPrompt !== null || questionPrompt !== null
    }),
    [approvalPrompt, questionPrompt, queueSendsNext, turnId]
  )
  const { rewind, sendWithOutcome } = useMobileStructuredAgentRewind({
    ...args,
    state,
    stateRef,
    options,
    turnId,
    backgroundTasks,
    sendsOut,
    commandPendingRef,
    queuedMessages,
    send: sendWithOutcomeUngated
  })
  useMobileStructuredThreadGoalSend(goal.sendRef, sendWithOutcome)
  const usageLimit = useMobileNativeChatUsageLimit(args, state, {
    busy: isWorking || queueSendsNext || sendsOut.sending(),
    send: sendWithOutcome
  })
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
  const requestCancel = useMobileStructuredRequestCancel({
    client,
    enabled,
    hostSupport,
    onSendError,
    sessionId,
    stateRef
  })

  return {
    ...optionFields,
    contextUsage: useMobileStructuredContextUsage(state.items, contextUsageSupport, state.epoch),
    visualSource: useMemo<MobileNativeChatVisualSource | null>(
      () => (client && sessionId ? { client, sessionId } : null),
      [client, sessionId]
    ),
    asyncQuestionSourceScope: questionSourceScope({ kind: 'journal', agent, sessionId, epoch }),
    imagePreviewsByMessageId: sends.imagePreviewsByMessageId,
    submissions: state.submissions,
    session: {
      messages,
      status,
      // A stored copy can't answer "is this ask still open?" until a live frame confirms it.
      transcriptLoading: status === 'loading' || savedAt !== null,
      error: state.error,
      readFailedFinally: status === 'error' && isFinalAgentSessionReadRefusal(state.readRefusal),
      clearing,
      hasMore: state.hasOlder && olderPages !== 'unavailable' && !clearing,
      loadingEarlier: olderPages === 'loading',
      olderPages,
      loadEarlier,
      savedAt
    },
    isWorking: isWorking || queueSendsNext,
    canStop,
    sendFollowUp: turnIndicator.sendFollowUp ?? null,
    turnId,
    turnIndicator,
    ...turnTiming,
    sendWithOutcome,
    holdUnconfirmed: sends.holdUnconfirmed,
    cancel: () => void stopPress.track(() => requestCancel()),
    cancelPrompt: (prompt?: { itemId: string; expectedRevision: number }) =>
      requestCancel(prompt ?? pendingStructuredPromptIdentity(stateRef.current)),
    receipts,
    actionablePromptIds: state.actionablePromptIds,
    permission: projectStructuredPermission(approvalPrompt),
    question: projectStructuredQuestion(questionPrompt),
    respondPermission,
    respondQuestion,
    queued,
    commandRefusalCauses,
    backgroundTasks,
    interruptedContinue: useMobileStructuredInterruptedContinue(
      { client, sessionId, sessionKey, hostSupport, ...state },
      isWorking || queueSendsNext
    ),
    threadGoal: goal.threadGoal,
    rewind,
    usageLimit
  }
}
