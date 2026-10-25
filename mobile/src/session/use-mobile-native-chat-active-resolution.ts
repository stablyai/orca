import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
import { encodeNativeChatTranscriptIdentity } from '../../../src/shared/native-chat-transcript-retention'
import { resolveMobileNativeChat, type MobileNativeChatTab } from './mobile-native-chat-eligibility'
import {
  useMobileSessionViewMode,
  type MobileSessionViewModeController
} from './use-mobile-session-view-mode'

export function useMobileNativeChatActiveResolution(args: {
  hostId: string
  worktreeId: string
  activeSessionTab: MobileNativeChatTab | null
  activeSessionTabId: string | null
  activeHandleRef: MutableRefObject<string | null>
  nativeChatTranscriptIsLocalReadable: boolean
}): {
  sessionViewReady: boolean
  isTabChatView: (tabId: string) => boolean
  setTabView: MobileSessionViewModeController['setTabView']
  toggleTabChatView: (tabId: string) => void
  showNativeChat: boolean
  showNativeChatRef: MutableRefObject<boolean>
  activeChatAgent: string | null
  /** False when only memory names the agent; chat writes stay locked. */
  activeChatAgentConfirmed: boolean
  activeChatAgentRef: MutableRefObject<string | null>
  activeChatSessionId: string | null
  activeChatStructured: boolean
  activeChatResolution: ReturnType<typeof resolveMobileNativeChat>
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
  const {
    ready: sessionViewReady,
    isTabChatView,
    setTabView,
    toggleTabChatView
  } = useMobileSessionViewMode({ hostId, worktreeId })
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
  const activeChatAgentRef = useRef<string | null>(activeChatAgent)

  useLayoutEffect(() => {
    showNativeChatRef.current = showNativeChat
    activeChatAgentRef.current = activeChatAgent
  }, [activeChatAgent, showNativeChat])

  const activeChatSessionId = activeChatResolution?.sessionId ?? null
  const activeChatStructured =
    activeChatResolution != null && activeSessionTab?.type === 'agent-session'
  const activeTabStatus = activeSessionTab?.agentStatus
  // Why: a turn restored across a host restart is unverifiable, so it must not offer Stop.
  const activeTabAgentWorking =
    activeTabStatus?.state === 'working' &&
    activeTabStatus.workingMode !== 'monitoring' &&
    activeTabStatus.restoredUnconfirmed !== true
  const nativeChatStatus = activeChatResolution && !activeChatStructured ? activeTabStatus : null
  const routeKey = `${hostId}\0${worktreeId}\0${activeSessionTabId ?? ''}`
  const streamIdentity = `${routeKey}\0${activeChatSessionId ?? ''}\0${activeHandleRef.current ?? ''}`
  const providerSessionId = activeSessionTab?.agentStatus?.providerSession?.id ?? ''
  const streamScopeKey = `${routeKey}\0${activeChatSessionId ?? providerSessionId}\0${activeHandleRef.current ?? ''}`

  return {
    sessionViewReady,
    isTabChatView,
    setTabView,
    toggleTabChatView,
    showNativeChat,
    showNativeChatRef,
    activeChatAgent,
    activeChatAgentConfirmed: activeChatResolution?.agentConfirmed !== false,
    activeChatAgentRef,
    activeChatSessionId,
    activeChatStructured,
    activeChatResolution,
    activeTabAgentWorking,
    nativeChatStatus,
    sourceIdentity: encodeNativeChatTranscriptIdentity([hostId, worktreeId]),
    streamIdentity,
    streamScopeKey
  }
}
