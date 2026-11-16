import { useMobileFileTapHandlers } from './use-mobile-file-tap-handlers'
import { resolveMobileNativeChatSessionId } from '../../session/native-chat/conversation/mobile-native-chat-eligibility'
import { useProvideSessionScreenHandlers } from '../../session/session-screen-handlers'
import type { MobileSessionTab } from '../../session/tabs/mobile-session-tabs'
import type { MobileSessionTerminalSendActionsModel } from '../../terminal/session/input-controls/use-mobile-session-terminal-send-actions'

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

  return {
    handleFileTap,
    handleNativeChatFileTap
  }
}

export type MobileSessionFileActionsModel = MobileSessionTerminalSendActionsModel &
  ReturnType<typeof useMobileSessionFileActions>
