import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatTab } from './mobile-native-chat-eligibility'
import type { HostSessionNativeChatOperations } from './host-session-native-chat-operations'
import { useMobileNativeChatActiveResolution } from './use-mobile-native-chat-active-resolution'
import { useMobileNativeChatAskDismiss } from './use-mobile-native-chat-ask-dismiss'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { useMobileNativeChatFileSearch } from './use-mobile-native-chat-file-search'
import { useMobileNativeChatSessionOptionController } from './use-mobile-native-chat-session-option-controller'
import { useMobileNativeChatSessionLane } from './use-mobile-native-chat-session-lane'
import { useMobileNativeChatTerminalWrites } from './use-mobile-native-chat-terminal-writes'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'
import { useMobileNativeChatTarget } from './use-mobile-native-chat-target'
import { useNativeChatAcceptedAction } from './use-native-chat-action-outcomes'
import { useThrottledLatestValue } from './use-throttled-latest-value'
import { isMobileNativeChatAgentWorking } from './mobile-native-chat-working-state'
import { mobileNativeChatStreamPreview } from './mobile-native-chat-streaming-gate'
import type { HostSessionChatDraftOperations } from './host-session-chat-draft-operations'
import type { HostSessionChatPendingDeliveryOperations } from './host-session-chat-pending-delivery-operations'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
export type { MobileNativeChatController } from './mobile-native-chat-controller-contract'

const NATIVE_CHAT_STREAM_THROTTLE_MS = 50

/** Owns mobile native-chat state and teardown outside the already dense session
 *  route. The route remains responsible only for choosing and rendering the view. */
export function useMobileNativeChatController(args: {
  operations: HostSessionNativeChatOperations | null
  /** Structured agent sessions speak the agent-session RPC family directly; the
   *  hosted page has no client and so never resolves a structured tab. */
  client?: RpcClient | null
  draftOperations?: HostSessionChatDraftOperations | null
  pendingDeliveryOperations?: HostSessionChatPendingDeliveryOperations | null
  connected: boolean
  hostId: string
  worktreeId: string
  activeSessionTab: MobileNativeChatTab | null
  activeSessionTabId: string | null
  activeHandleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  nativeChatTranscriptIsLocalReadable: boolean
  nativeChatInputLeaseReady: boolean
  onSendError: (message: string) => void
  /** Retires a held failure banner. Any accepted chat write clears it — a delivered
   *  answer or permission reply must not sit under a stale "not sent". */
  onSendResolved: () => void
}): MobileNativeChatController {
  const {
    operations,
    client = null,
    draftOperations = null,
    pendingDeliveryOperations = null,
    connected,
    hostId,
    worktreeId,
    activeSessionTab,
    activeSessionTabId,
    activeHandleRef,
    deviceTokenRef,
    nativeChatTranscriptIsLocalReadable,
    nativeChatInputLeaseReady,
    onSendError,
    onSendResolved
  } = args
  const {
    activeChatAgent,
    activeChatAgentRef,
    activeChatResolution,
    activeChatSessionId,
    activeChatStructured,
    isTabChatView,
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
    connected,
    nativeChatTranscriptIsLocalReadable
  })

  const { target: nativeChatTarget, targetRef: nativeChatTargetRef } = useMobileNativeChatTarget({
    workspaceId: worktreeId,
    agent: activeChatAgent,
    sessionId: activeChatSessionId,
    transcriptPath: activeChatResolution?.transcriptPath ?? null,
    terminalId: activeHandleRef.current,
    clientId: deviceTokenRef.current
  })
  const { structuredSession: structuredNativeChat, session: nativeChatSession } =
    useMobileNativeChatSessionLane({
      operations,
      client,
      workspaceId: worktreeId,
      structured: activeChatStructured,
      agent: activeChatAgent,
      resolvedAgent: activeChatAgent,
      transcriptPath: activeChatResolution?.transcriptPath ?? null,
      sessionId: activeChatSessionId,
      terminalId: nativeChatTarget?.terminalId ?? null,
      clientId: nativeChatTarget?.clientId ?? null,
      sourceIdentity,
      enabled: showNativeChat,
      connected,
      onSendError
    })
  const {
    composerText: chatComposerText,
    setComposerText: setChatComposerText,
    getComposerEditGeneration: getChatComposerEditGeneration,
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
    persistence: draftOperations,
    pendingPersistence: pendingDeliveryOperations,
    transcriptSettled: nativeChatSession.status === 'ready'
  })

  const nativeChatStatus =
    activeChatResolution && !activeChatStructured ? activeSessionTab?.agentStatus : null
  const nativeChatAgentWorking = activeChatStructured
    ? structuredNativeChat.isWorking
    : isMobileNativeChatAgentWorking(nativeChatStatus, nativeChatSession.lifecycle)
  const nativeChatStreamLive = activeChatStructured
    ? structuredNativeChat.isWorking
    : activeSessionTab?.agentStatus?.state === 'working'
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
    question: legacyNativeChatQuestion,
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
  const {
    askKey: nativeChatAskKey,
    showAsk: showNativeChatAsk,
    dismissAsk: dismissNativeChatAsk
  } = useMobileNativeChatAskDismiss({
    ask: nativeChatAskPrompt,
    detectedAsk: nativeChatDetectedAsk,
    scopeKey: activeSessionTabId,
    sessionKey: activeChatSessionId,
    observing: showNativeChat && (nativeChatDetectedAsk != null || nativeChatTranscriptSettled)
  })

  // The explicit transport state collapses before the input lease on disconnect.
  const inputSendable = activeChatStructured
    ? client != null && activeChatSessionId != null && connected
    : nativeChatInputLeaseReady && connected

  // Why: the send seam reports outgoing catalog commands to session-option
  // tracking, but the options hook needs the seam's dispatcher — a ref breaks
  // the cycle without re-creating the send callbacks per snapshot.
  const recordSessionOptionCommandRef = useRef<(command: string) => void>(() => {})
  const terminalWrites = useMobileNativeChatTerminalWrites({
    operations,
    enabled: inputSendable && !activeChatStructured,
    targetRef: nativeChatTargetRef,
    agentRef: activeChatAgentRef,
    sessionId: activeChatSessionId,
    streamIdentity,
    commandSendRef: recordSessionOptionCommandRef,
    drafts: {
      captureSendOrigin,
      readSeededLaunchDraftSeed,
      clearDraftForSend,
      restoreRejectedDraft,
      acceptSend,
      holdUnconfirmedSend
    },
    onSendError
  })
  const structuredNativeChatSend = useMobileStructuredNativeChatSendBridge({
    sendStructured: structuredNativeChat.sendWithOutcome,
    captureSendOrigin,
    clearDraftForSend,
    acceptSend,
    holdUnconfirmedSend,
    restoreRejectedDraft,
    onSendError
  })

  const { nativeChatFilePaths, loadNativeChatFiles } = useMobileNativeChatFileSearch({
    operations,
    target: nativeChatTarget
  })
  const { nativeChatSessionOptions, recordCommand: recordNativeChatSessionOptionCommand } =
    useMobileNativeChatSessionOptionController({
      activeChatStructured,
      activeSessionTabId,
      agent: activeChatAgent,
      dispatchCommand: terminalWrites.dispatchCommand,
      hostId,
      isTabChatView,
      isWorking: nativeChatAgentWorking,
      reportedModel: activeSessionTab?.agentStatus?.model ?? null,
      structured: {
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
  }, [recordNativeChatSessionOptionCommand])
  // Card actions retire the route's held failure banner too, not just sends.
  const answerAsk = useNativeChatAcceptedAction(terminalWrites.answerAsk, onSendResolved)
  const cancelAsk = useNativeChatAcceptedAction(terminalWrites.cancelAsk, onSendResolved)
  const respond = useNativeChatAcceptedAction(
    activeChatStructured
      ? structuredNativeChat.respondPermission
      : terminalWrites.respondPermission,
    onSendResolved
  )

  return {
    isTabChatView,
    toggleTabChatView,
    showNativeChat,
    showNativeChatRef,
    nativeChatAgent: activeChatAgent,
    chatComposerText,
    setChatComposerText,
    getChatComposerEditGeneration,
    chatPending,
    chatImagePreviewsByMessageId,
    nativeChatSession,
    /** Structured lane: drives the per-turn status row and live tool progress. */
    nativeChatStructured: activeChatStructured,
    nativeChatAgentWorking,
    nativeChatTargetRef,
    nativeChatStreamingText,
    nativeChatStreamLive,
    nativeChatStreamScopeKey: streamScopeKey,
    nativeChatPermission: activeChatStructured
      ? structuredNativeChat.permission
      : legacyNativeChatPermission,
    nativeChatQuestion: activeChatStructured
      ? structuredNativeChat.question
      : legacyNativeChatQuestion,
    nativeChatAsk: !activeChatStructured && showNativeChatAsk ? nativeChatAskPrompt : null,
    nativeChatAskKey,
    dismissNativeChatAsk,
    handleNativeChatAnswerAsk: answerAsk,
    handleNativeChatCancelAsk: cancelAsk,
    handleNativeChatRespondPermission: respond,
    handleNativeChatStop: activeChatStructured ? structuredNativeChat.cancel : terminalWrites.stop,
    nativeChatFilePaths,
    loadNativeChatFiles,
    handleNativeChatQuestionAnswer: activeChatStructured
      ? structuredNativeChat.respondQuestion
      : terminalWrites.answerQuestion,
    handleNativeChatSend: activeChatStructured
      ? structuredNativeChatSend.send
      : terminalWrites.send,
    handleNativeChatSendWithOutcome: activeChatStructured
      ? structuredNativeChatSend.sendWithOutcome
      : terminalWrites.sendWithOutcome,
    readSeededLaunchDraft,
    nativeChatSessionOptions
  }
}
