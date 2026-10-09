import { useCallback, useMemo, useRef } from 'react'
import { encodeNativeChatTranscriptIdentity } from '../../../src/shared/native-chat-transcript-retention'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import { withNativeChatCutTurnNotices } from '../../../src/shared/native-chat-cut-turn-notice'
import { tuiAgentDisplayName } from '../../../src/shared/tui-agent-display-names'
import { isStructuredAgentSessionMainAgentWorking } from '../../../src/shared/structured-agent-session-main-agent-working'
import { isFinalAgentSessionReadRefusal } from '../../../src/shared/structured-agent-session-read-refusal'
import {
  isStructuredAgentSessionThinking,
  runningStructuredAgentSessionTurnId
} from '../../../src/shared/structured-agent-session-live-turn'
import { selectStructuredAgentTurnActivity } from '../../../src/shared/native-chat-turn-activity'
import {
  pendingStructuredApproval,
  pendingStructuredQuestion,
  projectStructuredPermission,
  projectStructuredQuestion
} from './mobile-structured-agent-prompts'
import type { StructuredMobileSession } from './mobile-structured-agent-session-contract'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'
import { useMobileStructuredStopPress } from './use-mobile-structured-stop-press'
import { useMobileStructuredSessionHostStopping } from './use-mobile-structured-session-host-stopping'
import { useMobileStructuredPromptResponses } from './use-mobile-structured-prompt-responses'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
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
import type { MobileNativeChatSendErrorReporter } from './use-mobile-native-chat-send-error'
import { useMobileStructuredQueuedMessageControls } from './use-mobile-structured-queued-message-controls'
import { useMobileStructuredBackgroundTasks } from './use-mobile-structured-background-tasks'

export function useMobileStructuredAgentSession(args: {
  client: RpcClient | null
  sessionId: string | null
  /** Host/workspace scope used to keep same provider ids isolated. */
  sourceIdentity?: string
  enabled: boolean
  /** Live transport only; gates the connection-scoped hold, and whether child rows may read live. */
  connected: boolean
  /** Capability facts from the shared runtime status probe; null follows the legacy wire. */
  hostSupport: StructuredAgentSessionHostSupport | null
  agent: string | null
  /** The active pane's live composer; Edit copies a card's text through it. */
  appendComposerText?: (text: string) => boolean
  onSendError: MobileNativeChatSendErrorReporter
  /** Called on any accepted queued-card action; retires the route's failure banner. */
  onActionResolved?: () => void
}): StructuredMobileSession {
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
  // Only a host that queues sends gets the delivery field; any host's published cards show.
  const queueCapable = hostSupport?.queuedMessages === true
  // A /compact waits in line only where its card renders.
  const commandsWait = queueCapable && hostSupport?.queuedCommands === true
  const promptCancelSupported = hostSupport?.promptCancel ?? null
  const hostAnswersRepeatedStops = hostSupport?.quietRepeatedStop ?? null
  const sessionKey = encodeNativeChatTranscriptIdentity([sourceIdentity, agent, sessionId])
  const commandPendingRef = useRef(false)
  // Against a host that predates the quiet repeated Stop, a Stop of a turn still being stopped joins it.
  const inFlightStopsRef = useRef(new Map<string, Promise<boolean>>())
  const stateArgs = { client, sessionId, sessionKey, enabled, connected }
  const { state, stateRef, queuedMessages, queuePause, loadingOlder, loadEarlier } =
    useMobileStructuredAgentState(stateArgs)

  const mutate = useMobileStructuredAgentMutate({
    client,
    sessionId,
    enabled,
    stateRef,
    onSendError
  })

  const options = useMobileStructuredAgentOptions({
    agent,
    client,
    sessionId,
    enabled,
    fence: state.fence,
    mutate
  })
  const { conversationCommands, invokeStructuredOption, optionSnapshot, setStructuredOption } =
    options
  // Stable across renders, or the send callback is rebuilt on every streamed frame.
  const sendController = useMemo(
    () => ({
      snapshot: optionSnapshot,
      setOption: setStructuredOption,
      invokeAction: invokeStructuredOption,
      conversationCommands
    }),
    [conversationCommands, invokeStructuredOption, optionSnapshot, setStructuredOption]
  )

  const sendWithOutcome = useMobileStructuredSendWithOutcome({
    agent,
    client,
    sessionId,
    enabled,
    queueCapable,
    commandsWait,
    stateRef,
    commandPending: commandPendingRef,
    controller: sendController,
    onSendError
  })
  const { groupedDraft, respondPermission, respondQuestion } = useMobileStructuredPromptResponses({
    stateRef,
    sessionKey,
    mutate,
    questionAnswersSupported: hostSupport?.questionAnswers ?? null,
    onSendError
  })

  // What the transcript reads, as desktop does: the journal plus the one notice a cut turn with no
  // row gets.
  const transcriptItems = useMemo(
    () =>
      withNativeChatCutTurnNotices(state.items, {
        agentName: agent ? (tuiAgentDisplayName(agent) ?? agent) : undefined
      }),
    [agent, state.items]
  )
  const messages = useMemo(
    // As on the desktop: a message the host recorded lives on its row, never back in the composer.
    () =>
      projectStructuredAgentSessionMessages(transcriptItems, [], state.submissions, {
        rejectedInPlace: true
      }),
    [transcriptItems, state.submissions]
  )
  const turnId = runningStructuredAgentSessionTurnId(state)
  const turnTiming = useMobileStructuredAgentTurnTiming(
    { ...state, items: transcriptItems },
    turnId
  )
  const activityText =
    selectStructuredAgentTurnActivity(state.items, turnId, state.activity)?.text ?? null
  const thinking = isStructuredAgentSessionThinking(state)
  const isWorking = isStructuredAgentSessionMainAgentWorking(turnId, state.submissions, state.fence)
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
  // The host's word, bridged by this phone's own press until its Stop event lands.
  const stopPress = useMobileStructuredStopPress(sessionKey)
  const stopping =
    agentStopDisplayStatus({
      working: isWorking,
      hostStopping,
      stopPressed: stopPress.pressed
    }) === 'stopping'
  const stopRequestInFlight = isWorking && stopPress.pressed
  const turnIndicator = useMemo(
    () => ({
      thinking,
      activityText,
      stopping,
      stopRequestInFlight,
      ...(stopping
        ? {
            afterStop: mobileStructuredSendQueues(queueCapable, state.items)
              ? ('queue' as const)
              : ('send' as const)
          }
        : {})
    }),
    [thinking, activityText, stopping, stopRequestInFlight, queueCapable, state.items]
  )
  const status = state.status === 'idle' ? 'idle' : state.status
  const approvalPrompt = useMemo(
    () => state.items.find(pendingStructuredApproval) ?? null,
    [state.items]
  )
  const questionPrompt = useMemo(
    () => state.items.find(pendingStructuredQuestion) ?? null,
    [state.items]
  )
  // What a refused command's line on the phone stands on.
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
    pendingPrompt: approvalPrompt !== null || questionPrompt !== null,
    agentWorking: isStructuredAgentSessionMainAgentWorking(turnId, state.submissions, state.fence),
    mutate,
    appendComposerText,
    onSendError,
    ...(onActionResolved ? { onActionResolved } : {})
  })
  // Stop never touches the queue: held cards stay on the host, visible on every
  // device, and resume only from the user's own next action.
  const requestCancel = useCallback(
    (prompt?: { itemId: string; expectedRevision: number }): Promise<boolean> =>
      requestMobileStructuredAgentSessionCancel({
        client,
        enabled,
        hostAnswersRepeatedStops,
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
    session: {
      messages,
      status,
      transcriptLoading: status === 'loading',
      error: state.error,
      readFailedFinally: status === 'error' && isFinalAgentSessionReadRefusal(state.readRefusal),
      hasMore: state.hasOlder,
      loadingEarlier: loadingOlder,
      loadEarlier
    },
    isWorking,
    turnId,
    turnIndicator,
    submissions: state.submissions,
    ...turnTiming,
    sendWithOutcome,
    cancel: () => {
      void stopPress.track(() => requestCancel())
    },
    cancelPrompt: (prompt?: { itemId: string; expectedRevision: number }) =>
      requestCancel(prompt ?? pendingStructuredPromptIdentity(stateRef.current.items)),
    permission: projectStructuredPermission(approvalPrompt),
    question: projectStructuredQuestion(questionPrompt, groupedDraft),
    respondPermission,
    respondQuestion,
    queued,
    commandRefusalCauses,
    backgroundTasks
  }
}
