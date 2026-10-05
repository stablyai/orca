import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
import { encodeNativeChatTranscriptIdentity } from '../../../src/shared/native-chat-transcript-retention'
import {
  conversationAddressKey,
  type TerminalConversationSelection
} from '../../../src/shared/terminal-conversation-identity'
import type { ConversationModelReport } from '../../../src/shared/terminal-conversation-model-report'
import {
  resolveMobileNativeChat,
  resolveMobileNativeChatFileSessionId,
  selectMobileTerminalConversation,
  type MobileNativeChatTab
} from './mobile-native-chat-eligibility'
import { useMobileSessionViewMode } from './use-mobile-session-view-mode'

export function useMobileNativeChatActiveResolution(args: {
  hostId: string
  worktreeId: string
  activeSessionTab: MobileNativeChatTab | null
  activeSessionTabId: string | null
  activeHandleRef: MutableRefObject<string | null>
  nativeChatTranscriptIsLocalReadable: boolean
}): {
  isTabChatView: (tabId: string) => boolean
  toggleTabChatView: (tabId: string) => void
  showNativeChat: boolean
  showNativeChatRef: MutableRefObject<boolean>
  activeChatAgent: string | null
  activeChatAgentRef: MutableRefObject<string | null>
  activeChatSessionId: string | null
  activeChatStructured: boolean
  activeChatResolution: ReturnType<typeof resolveMobileNativeChat>
  /** The model the active tab's conversation reports, and which evidence supplied it. */
  activeConversation: TerminalConversationSelection | null
  activeConversationModelReport: Omit<ConversationModelReport, 'model'> | undefined
  activeTabAgentWorking: boolean
  nativeChatStatus: MobileNativeChatTab['agentStatus'] | null
  sourceIdentity: string
  streamIdentity: string
  streamScopeKey: string
} {
  const {
    activeHandleRef,
    activeSessionTab,
    activeSessionTabId,
    hostId,
    nativeChatTranscriptIsLocalReadable,
    worktreeId
  } = args
  const { isTabChatView, toggleTabChatView } = useMobileSessionViewMode({ hostId, worktreeId })
  const tabWantsChat =
    activeSessionTab?.type === 'agent-session' ||
    (activeSessionTabId ? isTabChatView(activeSessionTabId) : false)
  const activeChatResolution =
    activeSessionTab && activeSessionTabId && tabWantsChat
      ? resolveMobileNativeChat(activeSessionTab, nativeChatTranscriptIsLocalReadable)
      : null
  const showNativeChat = activeChatResolution != null
  const showNativeChatRef = useRef(showNativeChat)
  const activeChatAgent = activeChatResolution?.agent ?? null
  const activeConversation = activeSessionTab
    ? selectMobileTerminalConversation(activeSessionTab, activeChatAgent)
    : null
  const activeConversationModelReport = activeConversation
    ? {
        conversationKey: conversationAddressKey(activeConversation.address),
        modelSource: activeConversation.modelSource,
        fieldReportKey: activeConversation.fieldReportKey
      }
    : undefined
  const activeChatAgentRef = useRef<string | null>(activeChatAgent)

  useLayoutEffect(() => {
    showNativeChatRef.current = showNativeChat
    activeChatAgentRef.current = activeChatAgent
  }, [activeChatAgent, showNativeChat])

  const activeChatSessionId = activeChatResolution?.sessionId ?? null
  const activeChatStructured =
    activeChatResolution != null && activeSessionTab?.type === 'agent-session'
  const activeTabStatus = activeSessionTab?.agentStatus
  const activeTabAgentWorking =
    activeTabStatus?.state === 'working' && activeTabStatus.workingMode !== 'monitoring'
  const nativeChatStatus = activeChatResolution && !activeChatStructured ? activeTabStatus : null
  const routeKey = `${hostId}\0${worktreeId}\0${activeSessionTabId ?? ''}`
  const streamIdentity = `${routeKey}\0${activeChatSessionId ?? ''}\0${activeHandleRef.current ?? ''}`
  const providerSessionId =
    (activeSessionTab?.type === 'terminal'
      ? resolveMobileNativeChatFileSessionId(activeSessionTab)
      : activeSessionTab?.agentStatus?.providerSession?.id) ?? ''
  const streamScopeKey = `${routeKey}\0${activeChatSessionId ?? providerSessionId}\0${activeHandleRef.current ?? ''}`

  return {
    isTabChatView,
    toggleTabChatView,
    showNativeChat,
    showNativeChatRef,
    activeChatAgent,
    activeChatAgentRef,
    activeChatSessionId,
    activeChatStructured,
    activeChatResolution,
    activeConversation,
    activeConversationModelReport,
    activeTabAgentWorking,
    nativeChatStatus,
    sourceIdentity: encodeNativeChatTranscriptIdentity([hostId, worktreeId]),
    streamIdentity,
    streamScopeKey
  }
}
