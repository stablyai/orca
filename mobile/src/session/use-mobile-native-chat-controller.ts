import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { MobileNativeChatTab } from './mobile-native-chat-eligibility'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileNativeChatAskDismiss } from './use-mobile-native-chat-ask-dismiss'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { useMobileNativeChatFileSearch } from './use-mobile-native-chat-file-search'
import { useMobileNativeChatMessageSend } from './use-mobile-native-chat-message-send'
import { mobileNativeChatStreamPreview } from './mobile-native-chat-streaming-gate'
import { useMobileNativeChatSessionOptionController } from './use-mobile-native-chat-session-option-controller'
import { useMobileNativeChatSessionLane } from './use-mobile-native-chat-session-lane'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'
import { useNativeChatAcceptedAction } from './use-native-chat-action-outcomes'
import { useThrottledLatestValue } from './use-throttled-latest-value'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
import { useMobileBridgeChatPromptWrites } from './use-mobile-bridge-chat-prompt-writes'
import { useMobileNativeChatActiveResolution } from './use-mobile-native-chat-active-resolution'
import { useMobileNativeChatPromptCards } from './use-mobile-native-chat-prompt-cards'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'

export type { MobileNativeChatController } from './mobile-native-chat-controller-contract'

const NATIVE_CHAT_STREAM_THROTTLE_MS = 50

/** Owns mobile native-chat state and teardown outside the already dense session
 *  route. The route remains responsible only for choosing and rendering the view. */
export function useMobileNativeChatController(args: {
  client: RpcClient | null
  hostId: string
  worktreeId: string
  activeSessionTab: MobileNativeChatTab | null
  activeSessionTabId: string | null
  activeHandleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  nativeChatTranscriptIsLocalReadable: boolean
  nativeChatInputLeaseReady: boolean
  /** Live socket state; the lease collapses on disconnect but one render later. */
  connState: ConnectionState
  /** Host capability fact from the shared runtime status probe. */
  agentSessionHostSupport?: StructuredAgentSessionHostSupport | null
  /** Forwarded to the session lane, a refusal's cause with it. */
  onSendError: Parameters<typeof useMobileNativeChatSessionLane>[0]['onSendError']
  /** Retires a held failure banner. Any accepted chat write clears it — a delivered
   *  answer or permission reply must not sit under a stale "not sent". */
  onSendResolved: () => void
}): MobileNativeChatController {
  const {
    client,
    hostId,
    worktreeId,
    activeSessionTab,
    activeSessionTabId,
    activeHandleRef,
    deviceTokenRef,
    nativeChatTranscriptIsLocalReadable,
    nativeChatInputLeaseReady,
    connState,
    agentSessionHostSupport = null,
    onSendError,
    onSendResolved
  } = args
  const {
    activeChatAgent,
    activeChatAgentRef,
    activeChatResolution,
    activeChatSessionId,
    activeChatStructured,
    activeTabAgentWorking,
    isTabChatView,
    nativeChatStatus,
    showNativeChat,
    showNativeChatRef,
    sourceIdentity,
    streamIdentity,
    streamScopeKey,
    toggleTabChatView
  } = useMobileNativeChatActiveResolution({
    hostId,
    worktreeId,
    activeSessionTab,
    activeSessionTabId,
    activeHandleRef,
    nativeChatTranscriptIsLocalReadable
  })

  // The lane runs before the drafts hook (fixed hook order); Edit's composer
  // append reaches the drafts state through this ref, set below once they exist.
  // Until the drafts mount, nothing is copied, so Edit deletes nothing.
  const appendComposerTextRef = useRef<(text: string) => boolean>(() => false)
  const { structuredSession: structuredNativeChat, session: nativeChatSession } =
    useMobileNativeChatSessionLane({
      client,
      structured: activeChatStructured,
      agent: activeChatAgent,
      resolvedAgent: activeChatResolution?.agent ?? null,
      transcriptPath: activeChatResolution?.transcriptPath ?? null,
      sessionId: activeChatSessionId,
      sourceIdentity,
      enabled: showNativeChat,
      connState,
      hostSupport: agentSessionHostSupport,
      appendComposerTextRef,
      onSendError,
      onActionResolved: onSendResolved
    })
  const {
    composerText: chatComposerText,
    setComposerText: setChatComposerText,
    getComposerEditGeneration: getChatComposerEditGeneration,
    appendComposerText,
    pending: chatPending,
    imagePreviewsByMessageId: chatImagePreviewsByMessageId,
    captureSendOrigin,
    readSeededLaunchDraft,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend
  } = useMobileNativeChatDrafts({
    hostId,
    worktreeId,
    tabId: activeSessionTabId,
    sessionId: activeChatSessionId,
    messages: nativeChatSession.messages,
    launchDraft: activeSessionTab?.launchDraft ?? null,
    launchDraftCreatedAt: activeSessionTab?.launchDraftCreatedAt ?? null,
    // Why: pass the raw draft plus this flag rather than nulling it off-chat —
    // a null is indistinguishable from a host retraction, and peeking at the
    // terminal view would permanently decline the prefill.
    chatActive: showNativeChat,
    transcriptLoading: nativeChatSession.transcriptLoading,
    transcriptSettled: nativeChatSession.status === 'ready',
    queuedCards: structuredNativeChat.queued.cards
  })

  // Deliberately not gated on the chat view being visible: the streaming gate
  // has to tell "hidden mid-turn" from "the turn ended".
  const nativeChatStreamLive = activeChatStructured
    ? structuredNativeChat.isWorking
    : activeTabAgentWorking
  const nativeChatAgentWorking =
    nativeChatStreamLive && (activeChatStructured || activeChatResolution != null)
  // Throttle the streaming bubble: OpenCode emits a status frame per streamed
  // part, and each one re-renders and re-parses the whole accumulated markdown.
  const nativeChatStreamingText = useThrottledLatestValue(
    activeChatStructured
      ? undefined
      : mobileNativeChatStreamPreview(nativeChatStatus, nativeChatAgentWorking),
    NATIVE_CHAT_STREAM_THROTTLE_MS
  )
  const {
    permission: legacyNativeChatPermission,
    question: legacyQuestion,
    detectedAsk: nativeChatDetectedAsk,
    ask: nativeChatAskPrompt
  } = useMobileNativeChatPrompts({
    enabled: activeChatResolution != null && !activeChatStructured,
    status: nativeChatStatus,
    messages: nativeChatSession.messages,
    transcriptLoading: nativeChatSession.transcriptLoading
  })
  // A never-read transcript cannot prove that a dismissed prompt cleared.
  const nativeChatTranscriptSettled =
    nativeChatSession.status === 'ready' ||
    (nativeChatSession.status === 'error' && nativeChatSession.messages.length > 0)
  const promptScopeKey = mobileNativeChatScopeKey(hostId, worktreeId, activeSessionTabId)
  const askDismissal = useMobileNativeChatAskDismiss({
    ask: nativeChatAskPrompt,
    detectedAsk: nativeChatDetectedAsk,
    scopeKey: promptScopeKey,
    sessionKey: activeChatSessionId,
    observing: showNativeChat && (nativeChatDetectedAsk != null || nativeChatTranscriptSettled)
  })

  // Every chat write gates on both: the lease proves the input floor is ours, and
  // `connState` collapses a render before the lease does on disconnect.
  const inputSendable = activeChatStructured
    ? client != null && activeChatSessionId != null && connState === 'connected'
    : nativeChatInputLeaseReady && connState === 'connected'

  const {
    answerAsk: handleNativeChatAnswerAsk,
    cancelAsk: handleNativeChatCancelAsk,
    respondPermission: legacyHandleNativeChatRespondPermission,
    stop: handleNativeChatStop
  } = useMobileBridgeChatPromptWrites({
    client,
    enabled: inputSendable && !activeChatStructured,
    handleRef: activeHandleRef,
    deviceTokenRef,
    agentRef: activeChatAgentRef,
    sessionId: activeChatSessionId,
    streamIdentity,
    onSendError
  })

  const nativeChatFiles = useMobileNativeChatFileSearch({ client, worktreeId })

  // Why: the send seam reports outgoing catalog commands to session-option
  // tracking, but the options hook needs the seam's dispatcher — a ref breaks
  // the cycle without re-creating the send callbacks per snapshot.
  const recordSessionOptionCommandRef = useRef<(command: string) => void>(() => {})

  const {
    send: handleNativeChatSend,
    sendWithOutcome: handleNativeChatSendWithOutcome,
    answerQuestion: legacyHandleNativeChatQuestionAnswer,
    dispatchCommand: handleNativeChatDispatchCommand
  } = useMobileNativeChatMessageSend({
    client,
    enabled: inputSendable && !activeChatStructured,
    handleRef: activeHandleRef,
    deviceTokenRef,
    agentRef: activeChatAgentRef,
    commandSendRef: recordSessionOptionCommandRef,
    captureSendOrigin,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend,
    onSendError
  })

  const structuredNativeChatSend = useMobileStructuredNativeChatSendBridge({
    agent: activeChatResolution?.agent === 'claude' ? 'claude' : 'codex',
    sendStructured: structuredNativeChat.sendWithOutcome,
    captureSendOrigin,
    clearDraftForSend,
    acceptSend,
    holdUnconfirmedSend,
    restoreRejectedDraft,
    onSendError
  })

  const { nativeChatSessionOptions, recordCommand: recordNativeChatSessionOptionCommand } =
    useMobileNativeChatSessionOptionController({
      client,
      activeChatStructured,
      activeSessionTabId,
      agent: activeChatResolution?.agent ?? null,
      dispatchCommand: handleNativeChatDispatchCommand,
      hostId,
      isTabChatView,
      isWorking: nativeChatAgentWorking,
      reportedModel: activeSessionTab?.agentStatus?.model ?? null,
      modelSwitchCommand: activeSessionTab?.agentStatus?.modelSwitchCommand,
      structured: {
        optionPickerRequest: structuredNativeChat.optionPickerRequest,
        conversationCommands: structuredNativeChat.conversationCommands,
        snapshot: structuredNativeChat.optionSnapshot,
        pendingId: structuredNativeChat.pendingOptionId,
        setOption: structuredNativeChat.setStructuredOption,
        invokeAction: structuredNativeChat.invokeStructuredOption
      },
      toggleTabChatView,
      worktreeId
    })
  useLayoutEffect(() => {
    recordSessionOptionCommandRef.current = recordNativeChatSessionOptionCommand
    appendComposerTextRef.current = appendComposerText
  }, [appendComposerText, recordNativeChatSessionOptionCommand])
  // Card actions retire the route's held failure banner too, not just sends.
  const answerAsk = useNativeChatAcceptedAction(handleNativeChatAnswerAsk, onSendResolved)
  const cancelAsk = useNativeChatAcceptedAction(handleNativeChatCancelAsk, onSendResolved)
  const promptCards = useMobileNativeChatPromptCards({
    terminal: {
      permission: legacyNativeChatPermission,
      question: legacyQuestion,
      waitStartedAt: nativeChatStatus?.stateStartedAt ?? null,
      scopeKey: promptScopeKey,
      sessionKey: streamIdentity,
      observing: showNativeChat && !activeChatStructured && nativeChatStatus != null,
      respondPermission: legacyHandleNativeChatRespondPermission,
      answerQuestion: legacyHandleNativeChatQuestionAnswer
    },
    structured: activeChatStructured ? structuredNativeChat : null,
    onSendResolved
  })

  return {
    isTabChatView,
    toggleTabChatView,
    showNativeChat,
    showNativeChatRef,
    nativeChatAgent: activeChatResolution?.agent ?? null,
    chatComposerText,
    setChatComposerText,
    getChatComposerEditGeneration,
    chatPending,
    chatImagePreviewsByMessageId,
    nativeChatSession,
    /** Structured lane: drives the per-turn status row and live tool progress. */
    nativeChatStructured: activeChatStructured,
    nativeChatVisualSource: activeChatStructured ? structuredNativeChat.visualSource : null,
    nativeChatAgentWorking,
    nativeChatTurnIndicator: activeChatStructured ? structuredNativeChat.turnIndicator : null,
    nativeChatWorkingStartedAt: activeChatStructured ? structuredNativeChat.workingStartedAt : null,
    nativeChatSettledTurns: activeChatStructured ? structuredNativeChat.settledTurns : null,
    nativeChatTurnJournal: activeChatStructured ? structuredNativeChat.turnJournal : null,
    // Only the structured lane names a refusal's cause; the bridge lane's starved ones drop none.
    nativeChatCommandRefusalCauses: structuredNativeChat.commandRefusalCauses,
    nativeChatCanStop: activeChatStructured
      ? structuredNativeChat.turnId !== null
      : nativeChatAgentWorking,
    nativeChatStreamingText,
    nativeChatStreamLive,
    nativeChatStreamScopeKey: streamScopeKey,
    ...promptCards,
    nativeChatAsk:
      !activeChatStructured && (askDismissal.showAsk || askDismissal.collapsedAsk)
        ? nativeChatAskPrompt
        : null,
    nativeChatAskKey: askDismissal.askKey,
    dismissNativeChatAsk: askDismissal.dismissAsk,
    collapseNativeChatAsk: askDismissal.collapseAsk,
    nativeChatCollapsedPrompt: askDismissal.collapsedAsk ?? promptCards.nativeChatCollapsedPrompt,
    handleNativeChatAnswerAsk: answerAsk,
    handleNativeChatCancelAsk: cancelAsk,
    handleNativeChatStop: activeChatStructured ? structuredNativeChat.cancel : handleNativeChatStop,
    // The inactive lane's session is starved of identity, so its cards stay empty.
    nativeChatQueued: structuredNativeChat.queued,
    nativeChatBackgroundTasks: activeChatStructured ? structuredNativeChat.backgroundTasks : null,
    ...nativeChatFiles,
    handleNativeChatSend: activeChatStructured
      ? structuredNativeChatSend.send
      : handleNativeChatSend,
    handleNativeChatSendWithOutcome: activeChatStructured
      ? structuredNativeChatSend.sendWithOutcome
      : handleNativeChatSendWithOutcome,
    readSeededLaunchDraft,
    nativeChatSessionOptions
  }
}
