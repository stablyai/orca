import { useRef, useCallback, useState } from 'react'
import { openExternalLink } from '../platform/external-link'
import { useMobileFileTapHandlers } from './use-mobile-file-tap-handlers'
import type { MobileFileTapResolvedConfirmation } from './mobile-file-tap-open'
import { resolveMobileNativeChatSessionId } from './native-chat/mobile-native-chat-eligibility'
import { useProvideSessionScreenHandlers } from './session-screen-handlers'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionTerminalSendActionsModel } from './use-mobile-session-terminal-send-actions'

export type PendingTerminalFileTap = MobileFileTapResolvedConfirmation & {
  onOpen: () => void
}

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
    fetchSessionTabs
  } = scope
  const [pendingTerminalFileTap, setPendingTerminalFileTap] =
    useState<PendingTerminalFileTap | null>(null)
  const fileInitialLineSeqRef = useRef(0)
  const [fileInitialLines, setFileInitialLines] = useState<
    ReadonlyMap<string, { line: number; seq: number }>
  >(() => new Map())
  const confirmTerminalFileTapOpen = useCallback(
    (target: MobileFileTapResolvedConfirmation, proceed: () => void) => {
      setPendingTerminalFileTap({ ...target, onOpen: proceed })
    },
    []
  )
  const revealFileLine = useCallback((relativePath: string, line: number) => {
    const seq = ++fileInitialLineSeqRef.current
    setFileInitialLines((prev) => new Map(prev).set(relativePath, { line, seq }))
  }, [])
  // Tap a terminal or chat file path → resolve on host, open as file tab/preview.
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
    confirmTerminalFileTapOpen,
    onRevealFileLine: revealFileLine
  })

  useProvideSessionScreenHandlers(hostId, worktreeId, {
    onResumedTerminal: switchTab
  })

  const handleTerminalOpenUrl = useCallback(
    (handle: string, url: string) => {
      if (handle !== activeHandleRef.current) {
        return
      }
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
  return {
    pendingTerminalFileTap,
    setPendingTerminalFileTap,
    fileInitialLines,
    handleFileTap,
    handleNativeChatFileTap,
    handleTerminalOpenUrl
  }
}

export type MobileSessionFileActionsModel = MobileSessionTerminalSendActionsModel &
  ReturnType<typeof useMobileSessionFileActions>
