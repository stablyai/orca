import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { useMobileSessionViewMode } from './use-mobile-session-view-mode'
import type { RpcClient } from '../transport/rpc-client'
import {
  parseAskFromStatus,
  type AskAnswerSelection,
  type AskPrompt
} from './mobile-native-chat-ask'
import { type MobileNativeChatTab, resolveMobileNativeChat } from './mobile-native-chat-eligibility'
import { detectAgentPermission } from './mobile-native-chat-permission'
import { parseAgentQuestion } from './mobile-native-chat-question'
import { openMobileNativeChatFile } from './mobile-native-chat-open-file'
import { useMobileNativeChatPermissionSend } from './mobile-native-chat-permission-send'
import { sendMobileNativeChatMessageWithOutcome } from './mobile-native-chat-send'
import { useMobileNativeChatAnswerSend } from './use-mobile-native-chat-answer-send'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { useMobileNativeChatFileSearch } from './use-mobile-native-chat-file-search'
import { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'
import { useMobileNativeChatStop } from './use-mobile-native-chat-stop'
import { useThrottledLatestValue } from './use-throttled-latest-value'

const NATIVE_CHAT_STREAM_THROTTLE_MS = 50

export type MobileNativeChatController = {
  /** Whether a tab's effective view is chat (per-tab override, else the default). */
  isTabChatView: (tabId: string) => boolean
  toggleTabChatView: (tabId: string) => void
  showNativeChat: boolean
  showNativeChatRef: MutableRefObject<boolean>
  /** Resolved agent for the active chat tab (names the empty-state copy). */
  nativeChatAgent: string | null
  chatComposerText: string
  setChatComposerText: Dispatch<SetStateAction<string>>
  chatPending: Array<{ id: string; text: string }>
  nativeChatSession: ReturnType<typeof useMobileNativeChatSession>
  nativeChatAgentWorking: boolean
  nativeChatStreamingText?: string
  nativeChatPermission: ReturnType<typeof detectAgentPermission>
  nativeChatQuestion: ReturnType<typeof parseAgentQuestion>
  nativeChatAsk: ReturnType<typeof parseAskFromStatus>
  handleNativeChatOpenFile: (relativePath: string) => void
  handleNativeChatAnswerAsk: (
    prompt: AskPrompt,
    selections: AskAnswerSelection[]
  ) => Promise<boolean>
  handleNativeChatCancelAsk: () => Promise<boolean>
  handleNativeChatRespondPermission: (text: string) => Promise<boolean>
  handleNativeChatStop: () => void
  nativeChatFilePaths: string[]
  loadNativeChatFiles: (query: string) => void
  handleNativeChatSend: (text: string) => Promise<boolean>
}

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
  onSendError: (message: string) => void
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
    onSendError
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
    acceptSend,
    holdUnconfirmedSend
  } = useMobileNativeChatDrafts({
    hostId,
    worktreeId,
    tabId: activeSessionTabId,
    sessionId: activeChatSessionId,
    messages: nativeChatSession.messages
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

  const { answerAsk: handleNativeChatAnswerAsk, cancelPending: cancelNativeChatAnswer } =
    useMobileNativeChatAnswerSend({
      client,
      enabled: nativeChatInputLeaseReady,
      handleRef: activeHandleRef,
      deviceTokenRef,
      agentRef: activeChatAgentRef,
      sessionId: activeChatSessionId,
      streamIdentity,
      onSendError
    })

  const handleNativeChatCancelAsk = useCallback(async (): Promise<boolean> => {
    const handle = activeHandleRef.current
    if (!client || !handle || !nativeChatInputLeaseReady) {
      onSendError('Cancel not sent (disconnected)')
      return false
    }
    cancelNativeChatAnswer()
    const outcome = await sendMobileNativeChatMessageWithOutcome({
      client,
      terminal: handle,
      text: String.fromCharCode(27),
      enter: false,
      ...(deviceTokenRef.current
        ? { mobileClient: { id: deviceTokenRef.current, type: 'mobile' } }
        : {})
    })
    if (outcome === 'unknown') {
      // Why: the Escape may have landed (ack lost / path cutover) — a definite
      // "not sent" would invite a second Escape into a changed prompt state.
      onSendError('Cancel unconfirmed — check chat before retrying')
    } else if (outcome === 'rejected') {
      onSendError('Cancel not sent')
    }
    return outcome === 'accepted'
  }, [
    activeHandleRef,
    cancelNativeChatAnswer,
    client,
    deviceTokenRef,
    nativeChatInputLeaseReady,
    onSendError
  ])

  const handleNativeChatRespondPermission = useMobileNativeChatPermissionSend({
    client,
    enabled: nativeChatInputLeaseReady,
    handleRef: activeHandleRef,
    deviceTokenRef,
    onSendError
  })

  const handleNativeChatStop = useMobileNativeChatStop({
    client,
    enabled: nativeChatInputLeaseReady,
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

  const handleNativeChatSend = useCallback(
    async (text: string): Promise<boolean> => {
      const handle = activeHandleRef.current
      const origin = captureSendOrigin(text)
      if (!client || !handle || !origin || !nativeChatInputLeaseReady) {
        onSendError('Message not sent (disconnected)')
        return false
      }
      const outcome = await sendMobileNativeChatMessageWithOutcome({
        client,
        terminal: handle,
        text,
        ...(deviceTokenRef.current
          ? { mobileClient: { id: deviceTokenRef.current, type: 'mobile' } }
          : {})
      })
      if (outcome === 'unknown') {
        // Why: an ack-lost send usually WAS delivered (issue seen on cellular
        // relay) — verify via the transcript echo instead of a false "not sent".
        holdUnconfirmedSend(origin, text, () =>
          onSendError('Delivery unconfirmed — check chat before retrying')
        )
        return true
      }
      if (outcome === 'rejected') {
        onSendError('Message not sent')
        return false
      }
      acceptSend(origin, text)
      return true
    },
    [
      acceptSend,
      activeHandleRef,
      captureSendOrigin,
      client,
      deviceTokenRef,
      holdUnconfirmedSend,
      nativeChatInputLeaseReady,
      onSendError
    ]
  )

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
    handleNativeChatAnswerAsk,
    handleNativeChatCancelAsk,
    handleNativeChatRespondPermission,
    handleNativeChatStop,
    nativeChatFilePaths,
    loadNativeChatFiles,
    handleNativeChatSend
  }
}
