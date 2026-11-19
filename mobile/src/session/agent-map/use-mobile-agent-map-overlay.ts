import { encodeNativeChatTranscriptIdentity } from '../../../../src/shared/native-chat/transcript/messages/native-chat-transcript-retention'
import {
  resolveMobileNativeChat,
  type MobileNativeChatTab
} from '../native-chat/conversation/mobile-native-chat-eligibility'
import type { MobileSessionView } from '../../storage/session-view-preferences'

// Owns the live agent map's overlay state. It reuses the session's view-mode
// controller so a map pick and the chat overlay never disagree about the tab.
export function useMobileAgentMapOverlay(args: {
  hostId: string
  worktreeId: string
  activeSessionTab: MobileNativeChatTab | null
  activeSessionTabId: string | null
  nativeChatTranscriptIsLocalReadable: boolean
  isTabMapView: (tabId: string) => boolean
  setTabView: (tabId: string, view: MobileSessionView) => void
}): {
  showAgentMap: boolean
  activeMapSessionId: string | null
  sourceIdentity: string
  isTabMapView: (tabId: string) => boolean
  setTabView: (tabId: string, view: MobileSessionView) => void
} {
  const {
    hostId,
    worktreeId,
    activeSessionTab,
    activeSessionTabId,
    nativeChatTranscriptIsLocalReadable,
    isTabMapView,
    setTabView
  } = args
  const wantsMap = activeSessionTabId ? isTabMapView(activeSessionTabId) : false
  const resolution =
    activeSessionTab && activeSessionTabId && wantsMap
      ? resolveMobileNativeChat(activeSessionTab, nativeChatTranscriptIsLocalReadable)
      : null
  return {
    showAgentMap: resolution != null,
    activeMapSessionId: resolution?.sessionId ?? null,
    sourceIdentity: encodeNativeChatTranscriptIdentity([hostId, worktreeId]),
    isTabMapView,
    setTabView
  }
}
