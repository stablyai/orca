import { useEffect, useState } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { firstParam } from '../navigation/route-param-reader'
import { usePageBridgeClient } from '../transport/connection/client-context.web'
import { activeSessionTabOf } from './tabs/active-session-tab'
import {
  peekStoredChatTranscript,
  readStoredChatTranscript,
  storedTabChatTranscriptIdentity
} from './native-chat/mobile-native-chat-transcript-store'
import type { MobileSessionKeyboardStateModel } from '../terminal/session/use-mobile-session-keyboard-state'

/**
 * A relaunch opens on the chat the stored strip had active when the phone holds a copy of it, until the
 * host's first snapshot picks the tab. Other tabs wait for that snapshot, so the body says connecting or offline.
 */
export function useMobileSessionStoredChatTab(scope: MobileSessionKeyboardStateModel): void {
  const {
    hostId,
    worktreeId,
    sessionTabs,
    activeSessionTabId,
    activeSessionTabIdRef,
    activeSessionTabTypeRef,
    appliedSnapshotMarkerRef,
    pendingSelectionRef,
    setActiveSessionTabId,
    nativeChatTranscriptIsLocalReadable,
    nativeChatController: { sessionViewReady, isTabChatView }
  } = scope
  // A notification or agent-row tap names its own pane (use-notification-pane-navigation), which wins.
  const client = usePageBridgeClient()
  const urlPaneKey = firstParam(useLocalSearchParams<{ paneKey?: string | string[] }>().paneKey)
  const [opensPane] = useState(
    () => Boolean(client.getShellSession()?.route?.params?.paneKey) || Boolean(urlPaneKey)
  )
  const storedActiveTab =
    activeSessionTabId === null && sessionViewReady && !opensPane
      ? activeSessionTabOf(sessionTabs)
      : null
  const storedChat =
    storedActiveTab &&
    (storedActiveTab.type === 'agent-session' || isTabChatView(storedActiveTab.id))
      ? storedTabChatTranscriptIdentity(
          hostId,
          worktreeId,
          storedActiveTab,
          nativeChatTranscriptIsLocalReadable
        )
      : null
  const storedChatTabId = storedChat ? storedActiveTab?.id : undefined
  const storedChatTabType = storedChat ? storedActiveTab?.type : undefined
  useEffect(() => {
    if (!storedChat || !storedChatTabId || !storedChatTabType) {
      return
    }
    let current = true
    const open = (held: unknown): void => {
      if (
        current &&
        held &&
        appliedSnapshotMarkerRef.current.version === -1 &&
        pendingSelectionRef.current === null
      ) {
        activeSessionTabTypeRef.current = storedChatTabType
        activeSessionTabIdRef.current = storedChatTabId
        setActiveSessionTabId(storedChatTabId)
      }
    }
    const held = peekStoredChatTranscript(storedChat)
    if (held === undefined) {
      void readStoredChatTranscript(storedChat).then(open)
    } else {
      open(held)
    }
    return () => {
      current = false
    }
  }, [
    activeSessionTabIdRef,
    activeSessionTabTypeRef,
    appliedSnapshotMarkerRef,
    pendingSelectionRef,
    setActiveSessionTabId,
    storedChat,
    storedChatTabId,
    storedChatTabType
  ])
}
