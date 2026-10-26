import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { MobileNativeChatTab } from './native-chat/mobile-native-chat-eligibility'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileNativeChatAskDismiss } from './use-mobile-native-chat-ask-dismiss'
import { useMobileNativeChatDrafts } from './native-chat/composer/use-mobile-native-chat-drafts'
import { useMobileNativeChatFileSearch } from './native-chat/composer/use-mobile-native-chat-file-search'
import { useMobileNativeChatMessageSend } from './use-mobile-native-chat-message-send'
import { mobileNativeChatStreamPreview } from './native-chat/mobile-native-chat-streaming-gate'
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
import { mobileNativeChatScopeKey } from './native-chat/mobile-native-chat-scope-key'

export type { MobileNativeChatController } from './mobile-native-chat-controller-contract'

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
  agentSessionHostSupport?: StructuredAgentSessionHostSupport | null
  onSendError: Parameters<typeof useMobileNativeChatSessionLane>[0]['onSendError']
  // Any accepted chat write clears the held failure banner, including answers and permission replies.
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
    nativeChatInputLeaseReady,
    connState,
    agentSessionHostSupport = null,
    onSendError,
    onSendResolved
  } = args
  const {
    activeChatAgentConfirmed,
    activeChatAgentRef,
    activeChatResolution,
    activeChatSessionId,
    activeChatStructured,
    activeTabAgentWorking,
    isTabChatView,
    sessionViewReady,
    setTabView,
    nativeChatStatus,
    showNativeChat,
    showNativeChatRef,
    sourceIdentity,
    streamIdentity,
    streamScopeKey,
    toggleTabChatView
  } = useMobileNativeChatActiveResolution(args)

  // Fixed hook order mounts the lane before drafts; defer Edit’s append through a ref and delete nothing until copying succeeds.
  const appendComposerTextRef = useRef<(text: string) => boolean>(() => false)
  const nativeChatLane = useMobileNativeChatSessionLane({
    client,
    hostId,
    structured: activeChatStructured,
    resolution: activeChatResolution,
    sourceIdentity,
    enabled: showNativeChat,
    connState,
    hostSupport: agentSessionHostSupport,
    appendComposerTextRef,
    onSendError,
    onActionResolved: onSendResolved
  })
  const { structuredSession: structuredNativeChat, session: nativeChatSession } = nativeChatLane
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
    // Off-chat null would look like host retraction and permanently decline launch prefill; preserve the draft plus visibility.
    chatActive: showNativeChat,
    transcriptLoading: nativeChatSession.transcriptLoading,
    transcriptSettled: nativeChatSession.status === 'ready'
  })

  // Observe turn liveness even off-chat so hidden mid-turn cannot look ended.
  const nativeChatStreamLive = activeChatStructured
    ? structuredNativeChat.isWorking
    : activeTabAgentWorking
  const nativeChatAgentWorking =
    nativeChatStreamLive && (activeChatStructured || activeChatResolution != null)
  // Throttle status-part previews to avoid reparsing the whole accumulated markdown per part.
  const nativeChatStreamingText = useThrottledLatestValue(
    activeChatStructured
      ? undefined
      : mobileNativeChatStreamPreview(nativeChatStatus, nativeChatAgentWorking),
    50
  )
  const {
    permission: legacyNativeChatPermission,
    question: legacyQuestion,
    detectedAsk: nativeChatDetectedAsk,
    ask: nativeChatAskPrompt,
    structuredAnswer
  } = useMobileNativeChatPrompts({
    enabled: activeChatStructured || activeChatResolution != null,
    structured: activeChatStructured ? structuredNativeChat : null,
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

  // Require both input lease and live connection; remembered-only agents may now be shells and must never receive chat writes.
  const inputSendable = activeChatStructured
    ? client != null && activeChatSessionId != null && connState === 'connected'
    : nativeChatInputLeaseReady && connState === 'connected' && activeChatAgentConfirmed

  const {
    answerAsk: bridgeAnswerAsk,
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

  // Break the send/options cycle through a ref so snapshot changes cannot recreate send callbacks.
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
    agent: activeChatResolution?.agent,
    sessionCommands: nativeChatLane.sessionCommands.commands,
    sendStructured: structuredNativeChat.sendWithOutcome,
    captureSendOrigin,
    clearDraftForSend,
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
        optionSurface: structuredNativeChat.optionSurface,
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
  const answerAsk = useNativeChatAcceptedAction(structuredAnswer ?? bridgeAnswerAsk, onSendResolved)
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
    sessionViewReady,
    isTabChatView,
    setTabView,
    toggleTabChatView,
    showNativeChat,
    showNativeChatRef,
    nativeChatAgent: activeChatResolution?.agent ?? null,
    chatComposerText,
    setChatComposerText,
    getChatComposerEditGeneration,
    chatPending,
    chatImagePreviewsByMessageId: activeChatStructured
      ? structuredNativeChat.imagePreviewsByMessageId
      : chatImagePreviewsByMessageId,
    nativeChatSession,
    nativeChatStructured: activeChatStructured,
    nativeChatVisualSource: activeChatStructured ? structuredNativeChat.visualSource : null,
    nativeChatItemSource:
      activeChatStructured && agentSessionHostSupport?.itemDetail === true
        ? structuredNativeChat.visualSource
        : null,
    nativeChatAgentWorking,
    nativeChatTurnIndicator: activeChatStructured ? structuredNativeChat.turnIndicator : null,
    nativeChatWorkingStartedAt: activeChatStructured ? structuredNativeChat.workingStartedAt : null,
    nativeChatSettledTurns: activeChatStructured ? structuredNativeChat.settledTurns : null,
    nativeChatTurnJournal: activeChatStructured ? structuredNativeChat.turnJournal : null,
    nativeChatReceipts: activeChatStructured ? structuredNativeChat.receipts : null,
    nativeChatActionablePromptIds: structuredNativeChat.actionablePromptIds,
    nativeChatCommandRefusalCauses: structuredNativeChat.commandRefusalCauses,
    // A host that stops what the chat has in flight takes Stop before the agent opens a turn.
    nativeChatCanStop: activeChatStructured
      ? structuredNativeChat.turnId !== null ||
        (agentSessionHostSupport?.conversationStop === true && structuredNativeChat.isWorking)
      : nativeChatAgentWorking,
    nativeChatStreamingText,
    nativeChatStreamLive,
    nativeChatStreamScopeKey: streamScopeKey,
    ...promptCards,
    nativeChatAsk: askDismissal.showAsk || askDismissal.collapsedAsk ? nativeChatAskPrompt : null,
    nativeChatAskKey: askDismissal.askKey,
    dismissNativeChatAsk: askDismissal.dismissAsk,
    collapseNativeChatAsk: askDismissal.collapseAsk,
    nativeChatCollapsedPrompt: askDismissal.collapsedAsk ?? promptCards.nativeChatCollapsedPrompt,
    handleNativeChatAnswerAsk: answerAsk,
    handleNativeChatCancelAsk: cancelAsk,
    handleNativeChatStop: activeChatStructured ? structuredNativeChat.cancel : handleNativeChatStop,
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
    nativeChatSessionOptions,
    nativeChatSessionCommands: nativeChatLane.sessionCommands,
    nativeChatAcceptsImages: !activeChatStructured || structuredNativeChat.acceptsImages
  }
}
