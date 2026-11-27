import { useRef, useCallback, useState } from 'react'
import { useMobileFileTapHandlers } from './use-mobile-file-tap-handlers'
import type { MobileFileTapResolvedConfirmation } from './mobile-file-tap-open'
import { resolveMobileNativeChatSessionId } from '../../session/native-chat/conversation/mobile-native-chat-eligibility'
import { useProvideSessionScreenHandlers } from '../../session/session-screen-handlers'
import type { MobileSessionTab } from '../../session/tabs/mobile-session-tabs'
import type { MobileSessionTerminalSendActionsModel } from '../../terminal/session/input-controls/use-mobile-session-terminal-send-actions'

export type PendingTerminalFileTap = MobileFileTapResolvedConfirmation & {
  onOpen: () => void
}

export function useMobileSessionFileActions(scope: MobileSessionTerminalSendActionsModel) {
  const {
    hostId,
    worktreeId,
    routeWorktreeName,
    client,
    sessionTabsRef,
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
    onRevealFileLine: revealFileLine,
    getSendCompletionGeneration
  })

  useProvideSessionScreenHandlers(hostId, worktreeId, {
    onResumedTerminal: switchTab
  })

  return {
    pendingTerminalFileTap,
    setPendingTerminalFileTap,
    fileInitialLines,
    handleFileTap,
    handleNativeChatFileTap
  }
}

export type MobileSessionFileActionsModel = MobileSessionTerminalSendActionsModel &
  ReturnType<typeof useMobileSessionFileActions>
