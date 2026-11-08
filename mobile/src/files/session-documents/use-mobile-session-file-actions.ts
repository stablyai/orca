import { useCallback, useState } from 'react'
import { openExternalLink } from '../../platform/external-link'
import { triggerSelection } from '../../platform/haptics'
import { useMobileFileTapHandlers } from './use-mobile-file-tap-handlers'
import {
  displayTitleFromTerminalUrl,
  type PendingTerminalUrlTap
} from '../../session/MobileTerminalUrlTapSheet'
import { resolveMobileNativeChatSessionId } from '../../session/native-chat/mobile-native-chat-eligibility'
import { useProvideSessionScreenHandlers } from '../../session/session-screen-handlers'
import type { MobileSessionTab } from '../../session/tabs/mobile-session-tabs'
import type { MobileSessionTerminalSendActionsModel } from '../../terminal/session/use-mobile-session-terminal-send-actions'

export function useMobileSessionFileActions(scope: MobileSessionTerminalSendActionsModel) {
  const {
    hostId,
    worktreeId,
    routeWorktreeName,
    isFloatingWorkspaceRoute,
    client,
    sessionTabsRef,
    terminalLinkOpenMode,
    activeSessionTabIdRef,
    terminalCwdRef,
    activeHandleRef,
    activeSessionTab,
    activeSessionTabTypeRef,
    switchSessionTabRef,
    switchTab,
    handleCreateBrowserRef,
    scheduleDelayedAction,
    nativeChatSendError,
    fetchSessionTabs,
    getSendCompletionGeneration
  } = scope
  const { handleFileTap, handleNativeChatFileTap } = useMobileFileTapHandlers<MobileSessionTab>({
    client,
    hostId,
    worktreeId,
    worktreeName: routeWorktreeName,
    nativeChatSessionId: resolveMobileNativeChatSessionId(activeSessionTab),
    structuredAttachments: activeSessionTab?.type === 'agent-session',
    activeHandleRef,
    terminalCwdRef,
    openBrowser: (url) => void handleCreateBrowserRef.current?.(url),
    fetchSessionTabs,
    getSessionTabs: () => sessionTabsRef.current,
    getActiveSessionTabId: () => activeSessionTabIdRef.current,
    getActiveSessionTabType: () => activeSessionTabTypeRef.current,
    switchSessionTab: (tab) => switchSessionTabRef.current?.(tab),
    scheduleDelayedAction,
    reportChatTapFailure: nativeChatSendError.show,
    getSendCompletionGeneration
  })

  useProvideSessionScreenHandlers(hostId, worktreeId, {
    onResumedTerminal: switchTab
  })

  const [pendingTerminalUrlTap, setPendingTerminalUrlTap] =
    useState<PendingTerminalUrlTap | null>(null)
  const openTerminalUrl = useCallback(
    (url: string) => {
      // Why: browser.tabCreate resolves a real worktree, which the floating
      // sentinel doesn't have — open taps in the phone browser instead.
      if (terminalLinkOpenMode === 'phone-browser' || isFloatingWorkspaceRoute) {
        openExternalLink(url)
        return
      }
      void handleCreateBrowserRef.current?.(url)
    },
    [terminalLinkOpenMode, isFloatingWorkspaceRoute]
  )
  const handleTerminalOpenUrl = useCallback(
    (handle: string, url: string) => {
      if (handle !== activeHandleRef.current) {
        return
      }
      const trimmedUrl = url.trim()
      if (!trimmedUrl) {
        return
      }
      triggerSelection()
      setPendingTerminalUrlTap({
        title: displayTitleFromTerminalUrl(trimmedUrl),
        url: trimmedUrl,
        onOpen: () => openTerminalUrl(trimmedUrl)
      })
    },
    [openTerminalUrl]
  )
  return {
    pendingTerminalUrlTap,
    setPendingTerminalUrlTap,
    handleFileTap,
    handleNativeChatFileTap,
    handleTerminalOpenUrl
  }
}

export type MobileSessionFileActionsModel = MobileSessionTerminalSendActionsModel &
  ReturnType<typeof useMobileSessionFileActions>
