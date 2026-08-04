import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { useMobileSessionViewMode } from './use-mobile-session-view-mode'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
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
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { useMobileNativeChatAnswerSend } from './use-mobile-native-chat-answer-send'
import { useMobileNativeChatCancelAsk } from './use-mobile-native-chat-cancel-ask'
import {
  useMobileNativeChatDrafts,
  type MobileNativeChatPendingMessage
} from './use-mobile-native-chat-drafts'
import { useMobileNativeChatFileSearch } from './use-mobile-native-chat-file-search'
import { useMobileNativeChatMessageSend } from './use-mobile-native-chat-message-send'
import { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'
import { useMobileNativeChatStop } from './use-mobile-native-chat-stop'
import { useMobileNativeChatControllerWriters } from './use-mobile-native-chat-controller-writers'
import { useThrottledLatestValue } from './use-throttled-latest-value'
import type { MobileNativeChatWriteAction } from './use-mobile-native-chat-writer-gate'

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
  chatPending: MobileNativeChatPendingMessage[]
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
  handleNativeChatQuestionAnswer: (text: string) => Promise<boolean>
  handleNativeChatSend: (text: string, images?: string[]) => Promise<boolean>
  /** Outcome-preserving send: callers that pasted terminal input beforehand
   *  (image sends) must see 'unknown' to heal a possibly-orphaned paste. Such a
   *  caller passes its own `deadline` so the paste it already spent and this text
   *  body share one budget instead of holding the composer for two. */
  handleNativeChatSendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number,
    owner?: MobileNativeChatWriteAction
  ) => Promise<MobileNativeChatSendOutcome>
  /** Owns one complete terminal action, including every paced or multi-write leg. */
  runNativeChatWrite: <Result>(
    write: (action: MobileNativeChatWriteAction | null) => Promise<Result>,
    staleResult: Result
  ) => Promise<Result>
  /** Launch-context text still parked on the agent's TUI input line, or null.
   *  Image sends read it to size their leading clear (one Ctrl+U per line). */
  readSeededLaunchDraft: () => string | null
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
    activeHandleRef,
    deviceTokenRef,
    nativeChatTranscriptIsLocalReadable,
    nativeChatInputLeaseReady,
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
  const { answerAsk: answerAskWrite, cancelPending: cancelNativeChatAnswer } =
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

  const cancelAskWrite = useMobileNativeChatCancelAsk({
    client,
    enabled: inputSendable,
    handleRef: activeHandleRef,
    deviceTokenRef,
    cancelPending: cancelNativeChatAnswer,
    onSendError
  })

  const permissionWrite = useMobileNativeChatPermissionSend({
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
    agentRef: activeChatAgentRef,
    sessionId: activeChatSessionId,
    streamIdentity,
    cancelPending: cancelNativeChatAnswer,
    onSendError
  })

  const { nativeChatFilePaths, loadNativeChatFiles } = useMobileNativeChatFileSearch({
    client,
    worktreeId
  })

  const {
    send: messageWrite,
    sendWithOutcome: messageWriteWithOutcome,
    answerQuestion: questionAnswerWrite
  } = useMobileNativeChatMessageSend({
    client,
    enabled: inputSendable,
    handleRef: activeHandleRef,
    deviceTokenRef,
    captureSendOrigin,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend,
    onSendError
  })
  const writers = useMobileNativeChatControllerWriters({
    client,
    enabled: inputSendable,
    handleRef: activeHandleRef,
    streamIdentity,
    answerAskWrite,
    cancelAskWrite,
    permissionWrite,
    questionAnswerWrite,
    messageWrite,
    messageWriteWithOutcome,
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
    chatPending,
    nativeChatSession,
    nativeChatAgentWorking,
    nativeChatStreamingText,
    nativeChatPermission,
    nativeChatQuestion,
    nativeChatAsk,
    handleNativeChatOpenFile,
    handleNativeChatAnswerAsk: writers.answerAsk,
    handleNativeChatCancelAsk: writers.cancelAsk,
    handleNativeChatRespondPermission: writers.respondPermission,
    handleNativeChatStop,
    nativeChatFilePaths,
    loadNativeChatFiles,
    handleNativeChatQuestionAnswer: writers.answerQuestion,
    handleNativeChatSend: writers.send,
    handleNativeChatSendWithOutcome: writers.sendWithOutcome,
    runNativeChatWrite: writers.runWrite,
    readSeededLaunchDraft
  }
}
