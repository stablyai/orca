import { useCallback, useRef, type RefObject } from 'react'
import { useMobileSessionViewMode } from './use-mobile-session-view-mode'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { type MobileNativeChatTab, resolveMobileNativeChat } from './mobile-native-chat-eligibility'
import { openMobileNativeChatFile } from './mobile-native-chat-open-file'
import { useMobileNativeChatPermissionSend } from './mobile-native-chat-permission-send'
import { useMobileNativeChatAnswerSend } from './use-mobile-native-chat-answer-send'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { useMobileNativeChatCancelAsk } from './use-mobile-native-chat-cancel-ask'
import { useMobileNativeChatFileSearch } from './use-mobile-native-chat-file-search'
import { useMobileNativeChatMessageSend } from './use-mobile-native-chat-message-send'
import { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'
import { useMobileNativeChatStop } from './use-mobile-native-chat-stop'
import { useNativeChatAcceptedAction } from './use-native-chat-action-outcomes'
import { useThrottledLatestValue } from './use-throttled-latest-value'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'

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
  activeSessionTabIdRef: RefObject<string | null>
  activeHandleRef: RefObject<string | null>
  deviceTokenRef: RefObject<string | null>
  nativeChatTranscriptIsLocalReadable: boolean
  nativeChatInputLeaseReady: boolean
  recoverInputLease: (
    rejectedHandle: string,
    expectedSessionTabId: string | null
  ) => Promise<boolean>
  /** Live socket state; the lease collapses on disconnect but one render later. */
  connState: ConnectionState
  onSendError: (message: string) => void
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
    activeSessionTabIdRef,
    activeHandleRef,
    deviceTokenRef,
    nativeChatTranscriptIsLocalReadable,
    nativeChatInputLeaseReady,
    recoverInputLease,
    connState,
    onSendError,
    onSendResolved
  } = args
  const { isTabChatView, toggleTabChatView } = useMobileSessionViewMode({ hostId, worktreeId })

  const activeChatResolution =
    activeSessionTab && activeSessionTabId && isTabChatView(activeSessionTabId)
      ? resolveMobileNativeChat(activeSessionTab, nativeChatTranscriptIsLocalReadable)
      : null
  const showNativeChat = activeChatResolution != null
  const showNativeChatRef = useRef(showNativeChat)
  showNativeChatRef.current = showNativeChat
  const activeChatAgentRef = useRef<string | null>(activeChatResolution?.agent ?? null)
  activeChatAgentRef.current = activeChatResolution?.agent ?? null

  const activeChatSessionId = activeChatResolution?.sessionId ?? null
  const streamIdentity = `${hostId}\0${worktreeId}\0${activeSessionTabId ?? ''}\0${activeChatSessionId ?? ''}\0${activeHandleRef.current ?? ''}`

  const nativeChatSession = useMobileNativeChatSession({
    client,
    agent: activeChatResolution?.agent ?? null,
    sessionId: activeChatSessionId,
    transcriptPath: activeChatResolution?.transcriptPath ?? null
  })
  const {
    composerText: chatComposerText,
    setComposerText: setChatComposerText,
    pending: chatPending,
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
    transcriptLoading: nativeChatSession.transcriptLoading
  })

  const nativeChatStatus = activeChatResolution ? activeSessionTab?.agentStatus : null
  const nativeChatAgentWorking = nativeChatStatus?.state === 'working'
  // Throttle the streaming bubble: OpenCode emits a status frame per streamed
  // part, and each one re-renders and re-parses the whole accumulated markdown.
  const nativeChatStreamingText = useThrottledLatestValue(
    nativeChatAgentWorking ? nativeChatStatus?.lastAssistantMessage : undefined,
    NATIVE_CHAT_STREAM_THROTTLE_MS
  )
  const {
    permission: nativeChatPermission,
    question: nativeChatQuestion,
    ask: nativeChatAsk
  } = useMobileNativeChatPrompts({
    enabled: activeChatResolution != null,
    status: nativeChatStatus,
    messages: nativeChatSession.messages
  })

  const handleNativeChatOpenFile = useCallback(
    (pathText: string) => {
      if (!client) {
        return
      }
      void openMobileNativeChatFile({
        client,
        worktreeId,
        pathText,
        terminal: activeHandleRef.current
      })
    },
    [activeHandleRef, client, worktreeId]
  )

  // Every chat write gates on both: the lease proves the input floor is ours, and
  // `connState` collapses a render before the lease does on disconnect.
  const inputSendable = nativeChatInputLeaseReady && connState === 'connected'

  const { answerAsk: handleNativeChatAnswerAsk, cancelPending: cancelNativeChatAnswer } =
    useMobileNativeChatAnswerSend({
      client,
      enabled: inputSendable,
      handleRef: activeHandleRef,
      deviceTokenRef,
      agentRef: activeChatAgentRef,
      sessionId: activeChatSessionId,
      streamIdentity,
      onSendError
    })

  const handleNativeChatCancelAsk = useMobileNativeChatCancelAsk({
    client,
    enabled: inputSendable,
    handleRef: activeHandleRef,
    deviceTokenRef,
    cancelPending: cancelNativeChatAnswer,
    onSendError
  })

  const handleNativeChatRespondPermission = useMobileNativeChatPermissionSend({
    client,
    enabled: inputSendable,
    handleRef: activeHandleRef,
    deviceTokenRef,
    onSendError
  })

  const handleNativeChatStop = useMobileNativeChatStop({
    client,
    enabled: inputSendable,
    handleRef: activeHandleRef,
    deviceTokenRef,
    streamIdentity,
    cancelPending: cancelNativeChatAnswer,
    onSendError
  })

  const { nativeChatFilePaths, loadNativeChatFiles } = useMobileNativeChatFileSearch({
    client,
    worktreeId
  })

  const {
    send: handleNativeChatSend,
    sendWithOutcome: handleNativeChatSendWithOutcome,
    answerQuestion: handleNativeChatQuestionAnswer
  } = useMobileNativeChatMessageSend({
    client,
    enabled: inputSendable,
    handleRef: activeHandleRef,
    deviceTokenRef,
    activeSessionTabIdRef,
    captureSendOrigin,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend,
    recoverInputLease,
    onSendError
  })
  // Card actions retire the route's held failure banner too, not just sends.
  const answerAsk = useNativeChatAcceptedAction(handleNativeChatAnswerAsk, onSendResolved)
  const cancelAsk = useNativeChatAcceptedAction(handleNativeChatCancelAsk, onSendResolved)
  const respond = useNativeChatAcceptedAction(handleNativeChatRespondPermission, onSendResolved)
  const answerQuestion = useNativeChatAcceptedAction(handleNativeChatQuestionAnswer, onSendResolved)

  return {
    isTabChatView,
    toggleTabChatView,
    showNativeChat,
    showNativeChatRef,
    nativeChatAgent: activeChatResolution?.agent ?? null,
    chatComposerText,
    setChatComposerText,
    chatPending,
    nativeChatSession,
    nativeChatAgentWorking,
    nativeChatStreamingText,
    nativeChatPermission,
    nativeChatQuestion,
    nativeChatAsk,
    handleNativeChatOpenFile,
    handleNativeChatAnswerAsk: answerAsk,
    handleNativeChatCancelAsk: cancelAsk,
    handleNativeChatRespondPermission: respond,
    handleNativeChatStop,
    nativeChatFilePaths,
    loadNativeChatFiles,
    handleNativeChatQuestionAnswer: answerQuestion,
    handleNativeChatSend,
    handleNativeChatSendWithOutcome,
    readSeededLaunchDraft
  }
}
