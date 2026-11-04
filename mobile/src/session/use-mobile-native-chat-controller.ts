import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { MobileNativeChatTab } from './native-chat/mobile-native-chat-eligibility'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileNativeChatDrafts } from './native-chat/composer/use-mobile-native-chat-drafts'
import { useMobileNativeChatWorkspaceCatalog } from './native-chat/composer/use-mobile-native-chat-workspace-catalog'
import { useMobileNativeChatMessageSend } from './native-chat/transcript/use-mobile-native-chat-message-send'
import { useMobileNativeChatSessionOptionController } from './native-chat/input/use-mobile-native-chat-session-option-controller'
import { useMobileNativeChatSessionLane } from './use-mobile-native-chat-session-lane'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'
import { useMobileNativeChatTerminalTurn } from './use-mobile-native-chat-terminal-turn'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
import { useMobileBridgeChatPromptWrites } from './use-mobile-bridge-chat-prompt-writes'
import { useMobileNativeChatActiveResolution } from './use-mobile-native-chat-active-resolution'
import { useMobileNativeChatPromptController } from './use-mobile-native-chat-prompt-controller'
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
  onQueuedEditNotice?: (message: string) => void
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
    activeChatAgent,
    activeChatAgentConfirmed,
    activeChatAgentRef,
    activeChatResolution,
    activeChatSessionId,
    activeChatStructured,
    isTabChatView,
    sessionViewReady,
    setTabView,
    nativeChatStatus,
    showNativeChat,
    showNativeChatRef,
    sourceIdentity,
    streamIdentity,
    toggleTabChatView
  } = useMobileNativeChatActiveResolution(args)

  // Fixed hook order mounts the lane before drafts; defer Edit’s append through a ref and delete nothing until copying succeeds.
  const appendComposerTextRef = useRef<(text: string) => boolean>(() => false)
  const nativeChatLane = useMobileNativeChatSessionLane({
    ...args,
    composerScopeKey: mobileNativeChatScopeKey(hostId, worktreeId, activeSessionTabId),
    structured: activeChatStructured,
    resolution: activeChatResolution,
    sourceIdentity,
    enabled: showNativeChat,
    hostSupport: agentSessionHostSupport,
    appendComposerTextRef,
    onActionResolved: onSendResolved
  })
  const { structuredSession: structuredNativeChat, session: nativeChatSession } = nativeChatLane
  const {
    draftKey: chatDraftKey,
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

  // Require both input lease and live connection; remembered-only agents may now be shells and must never receive chat writes.
  const inputSendable = activeChatStructured
    ? client != null && activeChatSessionId != null && connState === 'connected'
    : nativeChatInputLeaseReady && connState === 'connected' && activeChatAgentConfirmed

  const { stop: handleNativeChatStop, ...bridgePromptWrites } = useMobileBridgeChatPromptWrites({
    client,
    enabled: inputSendable && !activeChatStructured,
    handleRef: activeHandleRef,
    deviceTokenRef,
    agentRef: activeChatAgentRef,
    sessionId: activeChatSessionId,
    streamIdentity,
    onSendError
  })

  const { hasPromptCard, ...prompts } = useMobileNativeChatPromptController({
    enabled: activeChatStructured || activeChatResolution != null,
    structured: activeChatStructured ? structuredNativeChat : null,
    status: nativeChatStatus,
    session: nativeChatSession,
    scopeKey: mobileNativeChatScopeKey(hostId, worktreeId, activeSessionTabId),
    sessionId: activeChatSessionId,
    streamIdentity,
    visible: showNativeChat,
    terminal: bridgePromptWrites,
    onSendResolved
  })

  const terminalTurn = useMobileNativeChatTerminalTurn({
    status: nativeChatStatus,
    resolution: activeChatResolution,
    session: activeChatStructured ? null : nativeChatSession,
    latestPendingId: chatPending.at(-1)?.id ?? null,
    hasPromptCard,
    scopeKey: streamIdentity,
    stop: handleNativeChatStop
  })
  const activeTurn = activeChatStructured ? structuredNativeChat : terminalTurn
  const nativeChatAgentWorking = activeTurn.isWorking

  const workspaceCatalog = useMobileNativeChatWorkspaceCatalog(args, activeChatAgent)

  // Break the send/options cycle through a ref so snapshot changes cannot recreate send callbacks.
  const recordSessionOptionCommandRef = useRef<(command: string) => void>(() => {})

  const {
    send: handleNativeChatSend,
    sendWithOutcome: handleNativeChatSendWithOutcome,
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

  return {
    reportQueuedEditError: onSendError,
    chatComposerScopeKey: mobileNativeChatScopeKey(hostId, worktreeId, activeSessionTabId),
    sessionViewReady,
    isTabChatView,
    setTabView,
    toggleTabChatView,
    showNativeChat,
    showNativeChatRef,
    nativeChatAgent: activeChatResolution?.agent ?? null,
    nativeChatSessionLive: activeChatResolution?.sessionLive === true,
    chatDraftKey,
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
    nativeChatTurnActive: activeChatStructured
      ? structuredNativeChat.isWorking
      : terminalTurn.turnActive,
    nativeChatAwaitingInput: activeChatStructured ? null : terminalTurn.awaitingInput,
    nativeChatTurnIndicator: activeChatStructured ? structuredNativeChat.turnIndicator : null,
    nativeChatWorkingStartedAt: activeTurn.workingStartedAt,
    nativeChatSettledTurns: activeTurn.settledTurns,
    nativeChatTurnJournal: activeChatStructured ? structuredNativeChat.turnJournal : null,
    nativeChatReceipts: activeChatStructured ? structuredNativeChat.receipts : null,
    nativeChatActionablePromptIds: structuredNativeChat.actionablePromptIds,
    nativeChatCommandRefusalCauses: structuredNativeChat.commandRefusalCauses,
    nativeChatCanStop: activeChatStructured ? structuredNativeChat.canStop : nativeChatAgentWorking,
    nativeChatStreamingText: terminalTurn.streamingText,
    ...prompts,
    handleNativeChatStop: activeChatStructured ? structuredNativeChat.cancel : terminalTurn.stop,
    nativeChatQueued: structuredNativeChat.queued,
    nativeChatBackgroundTasks: activeChatStructured ? structuredNativeChat.backgroundTasks : null,
    ...workspaceCatalog,
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
