import { useEffect, useRef, type MutableRefObject } from 'react'
import { encodeNativeChatTranscriptIdentity } from '../../../src/shared/native-chat-transcript-retention'
import {
  resolveMobileNativeChat,
  type MobileNativeChatResolution,
  type MobileNativeChatTab
} from './mobile-native-chat-eligibility'
import {
  resolveMobileNativeChatDuringDisconnect,
  type MobileNativeChatDisconnectRetention
} from './mobile-native-chat-disconnect-retention'
import { useMobileSessionViewMode } from './use-mobile-session-view-mode'

/** Which chat (if any) the active tab shows, held across a disconnect so the
 *  overlay does not collapse to the terminal while the transport recovers. */
export function useMobileNativeChatActiveResolution(args: {
  hostId: string
  worktreeId: string
  activeSessionTab: MobileNativeChatTab | null
  activeSessionTabId: string | null
  activeHandleRef: MutableRefObject<string | null>
  connected: boolean
  nativeChatTranscriptIsLocalReadable: boolean
}): {
  isTabChatView: (tabId: string) => boolean
  toggleTabChatView: (tabId: string) => void
  showNativeChat: boolean
  showNativeChatRef: MutableRefObject<boolean>
  activeChatAgent: string | null
  activeChatAgentRef: MutableRefObject<string | null>
  activeChatSessionId: string | null
  /** The tab is a structured agent session (agent-session RPC family), not a terminal transcript. */
  activeChatStructured: boolean
  activeChatResolution: MobileNativeChatResolution | null
  sourceIdentity: string
  streamIdentity: string
  streamScopeKey: string
} {
  const {
    activeHandleRef,
    activeSessionTab,
    activeSessionTabId,
    connected,
    hostId,
    nativeChatTranscriptIsLocalReadable,
    worktreeId
  } = args
  const { isTabChatView, toggleTabChatView } = useMobileSessionViewMode({ hostId, worktreeId })

  const structuredTab = activeSessionTab?.type === 'agent-session'
  const chatViewSelected =
    structuredTab || (activeSessionTabId ? isTabChatView(activeSessionTabId) : false)
  const currentChatResolution =
    activeSessionTab && activeSessionTabId && chatViewSelected
      ? resolveMobileNativeChat(activeSessionTab, nativeChatTranscriptIsLocalReadable)
      : null
  const disconnectRetentionRef = useRef<MobileNativeChatDisconnectRetention | null>(null)
  const retainedChat = resolveMobileNativeChatDuringDisconnect({
    connected,
    hostId,
    worktreeId,
    tabId: activeSessionTabId,
    terminalTabPresent: activeSessionTab?.type === 'terminal',
    chatViewSelected,
    currentResolution: currentChatResolution,
    retained: disconnectRetentionRef.current
  })
  useEffect(() => {
    disconnectRetentionRef.current = retainedChat.retained
  }, [retainedChat.retained])
  const activeChatResolution = retainedChat.resolution
  const showNativeChat = activeChatResolution != null
  const showNativeChatRef = useRef(showNativeChat)
  const activeChatAgent = activeChatResolution?.agent ?? null
  const activeChatAgentRef = useRef<string | null>(activeChatAgent)
  useEffect(() => {
    showNativeChatRef.current = showNativeChat
    activeChatAgentRef.current = activeChatAgent
  }, [activeChatAgent, showNativeChat])

  const activeChatSessionId = activeChatResolution?.sessionId ?? null
  const activeTerminalId = activeHandleRef.current ?? ''
  const routeKey = `${hostId}\0${worktreeId}\0${activeSessionTabId ?? ''}`
  const streamIdentity = `${routeKey}\0${activeChatSessionId ?? ''}\0${activeTerminalId}`
  // Same chat, but keyed off the tab rather than the view-gated resolution:
  // `streamIdentity` goes session-less the moment the user peeks at the terminal,
  // and a scope that flips on a view toggle throws the gate's baseline away.
  const providerSessionId = activeSessionTab?.agentStatus?.providerSession?.id ?? ''
  const streamScopeKey = `${routeKey}\0${activeChatSessionId ?? providerSessionId}\0${activeTerminalId}`

  return {
    isTabChatView,
    toggleTabChatView,
    showNativeChat,
    showNativeChatRef,
    activeChatAgent,
    activeChatAgentRef,
    activeChatSessionId,
    activeChatStructured: activeChatResolution != null && structuredTab,
    activeChatResolution,
    sourceIdentity: encodeNativeChatTranscriptIdentity([hostId, worktreeId]),
    streamIdentity,
    streamScopeKey
  }
}
