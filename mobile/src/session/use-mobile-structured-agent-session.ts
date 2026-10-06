import { useCallback, useMemo, useRef } from 'react'
import { encodeNativeChatTranscriptIdentity } from '../../../src/shared/native-chat-transcript-retention'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import { withNativeChatCutTurnNotices } from '../../../src/shared/native-chat-cut-turn-notice'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/tui-agent-display-names'
import { isStructuredAgentSessionMainAgentWorking } from '../../../src/shared/structured-agent-session-main-agent-working'
import { isFinalAgentSessionReadRefusal } from '../../../src/shared/structured-agent-session-read-refusal'
import {
  activeStructuredAgentSessionTurnId,
  isStructuredAgentSessionThinking
} from '../../../src/shared/structured-agent-session-live-turn'
import { selectStructuredAgentTurnActivity } from '../../../src/shared/native-chat-turn-activity'
import {
  pendingStructuredApproval,
  pendingStructuredQuestion,
  projectStructuredPermission,
  projectStructuredQuestion
} from './mobile-structured-agent-prompts'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatSession } from './use-mobile-native-chat-session'
import type { NativeChatLiveTurnIndicator } from '../../../src/shared/native-chat-turn-status'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'
import { useMobileStructuredPromptResponses } from './use-mobile-structured-prompt-responses'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'
import { useMobileStructuredSendOperationReconciliation } from './use-mobile-structured-send-operation-reconciliation'
import {
  pendingStructuredPromptIdentity,
  requestMobileStructuredAgentSessionCancel
} from './mobile-structured-agent-session-cancel'
import { useMobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import {
  useMobileStructuredSendWithOutcome,
  type StructuredMobileSendAttachment
} from './use-mobile-structured-send-with-outcome'
import {
  useMobileStructuredQueuedMessageControls,
  type MobileStructuredQueuedMessageControls
} from './use-mobile-structured-queued-message-controls'
import type { MobileProviderSessions } from './mobile-structured-provider-session'

type StructuredMobileSession = ReturnType<typeof useMobileStructuredAgentOptions> &
  ReturnType<typeof useMobileStructuredAgentTurnTiming> & {
    session: MobileNativeChatSession
    isWorking: boolean
    turnId: string | null
    /** What labels the live turn's one indicator row. */
    turnIndicator: NativeChatLiveTurnIndicator
    sendWithOutcome: (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileSendAttachment[]
    ) => Promise<MobileNativeChatSendOutcome>
    cancel: () => void
    permission: MobileChatPermission | null
    question: MobileChatQuestion | null
    respondPermission: (optionId: string) => Promise<boolean>
    respondQuestion: (answer: string) => Promise<boolean>
    cancelPrompt: (prompt?: { itemId: string; expectedRevision: number }) => Promise<boolean>
    /** The queued-draft cards and their actions; empty and inert off capable hosts. */
    queued: MobileStructuredQueuedMessageControls
    /** Provider sessions read so far, by chat id; the terminal hand-off's own source. */
    providerSessions: MobileProviderSessions
  }

export function useMobileStructuredAgentSession(args: {
  client: RpcClient | null
  sessionId: string | null
  /** Host/workspace scope used to keep same provider ids isolated. */
  sourceIdentity?: string
  /** Authenticated identity the host keys mutation admission under. */
  callerIdentity?: string
  enabled: boolean
  /** Live transport only; gates the connection-scoped hold, nothing else. */
  connected: boolean
  /** Capability facts from the shared runtime status probe; null follows the legacy wire. */
  hostSupport: StructuredAgentSessionHostSupport | null
  agent: string | null
  /** The active pane's live composer; Edit copies a card's text through it. */
  appendComposerText?: (text: string) => boolean
  onSendError: (message: string) => void
  /** Called on any accepted queued-card action; retires the route's failure banner. */
  onActionResolved?: () => void
}): StructuredMobileSession {
  const {
    agent,
    appendComposerText,
    callerIdentity = '',
    client,
    connected,
    sessionId,
    sourceIdentity = '',
    enabled,
    onActionResolved,
    onSendError,
    hostSupport
  } = args
  // Old host ⇒ exactly today's behavior: no delivery field, no cards, plain Stop.
  const queueCapable = hostSupport?.queuedMessages === true
  const promptCancelSupported = hostSupport?.promptCancel ?? null
  const hostAnswersRepeatedStops = hostSupport?.quietRepeatedStop ?? null
  const sessionKey = encodeNativeChatTranscriptIdentity([sourceIdentity, agent, sessionId])
  const commandPendingRef = useRef(false)
  // Against a host that predates the quiet repeated Stop, a Stop of a turn still being stopped joins it.
  const inFlightStopsRef = useRef(new Map<string, Promise<boolean>>())
  const stateArgs = { client, sessionId, sessionKey, enabled, connected }
  const {
    state,
    stateRef,
    queuedMessages,
    queuePause,
    providerSessions,
    loadingOlder,
    loadEarlier
  } = useMobileStructuredAgentState(stateArgs)
  useMobileStructuredSendOperationReconciliation(state.submissions, queuedMessages)

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
    callerIdentity,
    client,
    sessionId,
    sessionKey,
    enabled,
    queueCapable,
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
        agentName: TUI_AGENT_DISPLAY_NAMES[agent === 'codex' ? 'codex' : 'claude']
      }),
    [agent, state.items]
  )
  const messages = useMemo(
    // Off: the phone hands a rejected message back to its composer, so a row would show it twice.
    () =>
      projectStructuredAgentSessionMessages(transcriptItems, [], state.submissions, {
        rejectedInPlace: false
      }),
    [transcriptItems, state.submissions]
  )
  const turnId = activeStructuredAgentSessionTurnId(state.items)
  const turnTiming = useMobileStructuredAgentTurnTiming(
    { ...state, items: transcriptItems },
    turnId
  )
  const activityText =
    selectStructuredAgentTurnActivity(state.items, turnId, state.activity)?.text ?? null
  const thinking = isStructuredAgentSessionThinking(state.items)
  const turnIndicator = useMemo(() => ({ thinking, activityText }), [thinking, activityText])
  const status = state.status === 'idle' ? 'idle' : state.status
  const approvalPrompt = useMemo(
    () => state.items.find(pendingStructuredApproval) ?? null,
    [state.items]
  )
  const questionPrompt = useMemo(
    () => state.items.find(pendingStructuredQuestion) ?? null,
    [state.items]
  )
  const queued = useMobileStructuredQueuedMessageControls({
    queueCapable,
    sessionKey,
    queuedMessages,
    queuePause,
    submissions: state.submissions,
    pendingPrompt: approvalPrompt !== null || questionPrompt !== null,
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

  return {
    ...options,
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
    isWorking: isStructuredAgentSessionMainAgentWorking(turnId, state.submissions, state.fence),
    turnId,
    turnIndicator,
    ...turnTiming,
    sendWithOutcome,
    cancel: () => {
      void requestCancel()
    },
    cancelPrompt: (prompt?: { itemId: string; expectedRevision: number }) =>
      requestCancel(prompt ?? pendingStructuredPromptIdentity(stateRef.current.items)),
    permission: projectStructuredPermission(approvalPrompt),
    question: projectStructuredQuestion(questionPrompt, groupedDraft),
    respondPermission,
    respondQuestion,
    queued,
    providerSessions
  }
}
