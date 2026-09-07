import { useEffect } from 'react'
import {
  createBulkCloseSheetActions,
  createCloseWithBulkActions
} from './mobile-bulk-close-sheet-actions'
import type { RpcSuccess } from '../transport/types'
import { activateMobileSessionTab } from './mobile-session-tab-activation'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'
import type { MobileSessionCloseActionsModel } from './use-mobile-session-close-actions'

export function useMobileSessionBulkClose(scope: MobileSessionCloseActionsModel) {
  const {
    worktreeId,
    client,
    connState,
    sessionTabs,
    sessionTabsRef,
    activeSessionTabIdRef,
    markdownDocs,
    pendingTerminalActivationAttemptRef,
    activeSessionTab,
    scheduleDelayedAction,
    applySessionTabs,
    fetchSessionTabs,
    switchSessionTab,
    handleCloseSessionTab,
    pendingTerminalRecoveryContextKey,
    parkedPendingTerminalContext,
    retryPendingTerminalRecovery
  } = scope
  const bulkCloseActions = createBulkCloseSheetActions({
    sessionTabsRef,
    markdownDocs,
    activeSessionTabIdRef,
    switchSessionTab,
    closeSessionTab: handleCloseSessionTab
  })
  const closeWithBulkActions = createCloseWithBulkActions(handleCloseSessionTab, bulkCloseActions)

  const visibleTabs: MobileSessionTab[] = sessionTabs
  const activeMarkdownTab = activeSessionTab?.type === 'markdown' ? activeSessionTab : null
  const activeFileTab = activeSessionTab?.type === 'file' ? activeSessionTab : null
  const activeBrowserTab = activeSessionTab?.type === 'browser' ? activeSessionTab : null
  const activePendingTerminalTab =
    activeSessionTab?.type === 'terminal' && typeof activeSessionTab.terminal !== 'string'
      ? activeSessionTab
      : null
  const isPendingTerminalRecoveryParked =
    pendingTerminalRecoveryContextKey !== null &&
    pendingTerminalRecoveryContextKey === parkedPendingTerminalContext

  useEffect(() => {
    if (!client || connState !== 'connected' || !activePendingTerminalTab) {
      if (connState !== 'connected' || !activePendingTerminalTab) {
        pendingTerminalActivationAttemptRef.current = null
      }
      return
    }
    const activationKey = `${worktreeId}:${activePendingTerminalTab.id}:${activePendingTerminalTab.leafId ?? ''}`
    if (pendingTerminalActivationAttemptRef.current === activationKey) {
      return
    }
    // Why: a server-owned tab can be active but still pending; activation is the RPC that materializes its PTY handle.
    pendingTerminalActivationAttemptRef.current = activationKey
    void activateMobileSessionTab(client, {
      worktree: `id:${worktreeId}`,
      tabId: activePendingTerminalTab.id,
      leafId: activePendingTerminalTab.leafId,
      notifyClients: false,
      navigation: 'caller',
      // Why: this only ever runs for the tab the user is looking at, so it is the
      // tail of their tap — the gesture that materializes a parked pane.
      intent: 'user'
    })
      .then((response) => {
        if (!response.ok) {
          if (pendingTerminalActivationAttemptRef.current === activationKey) {
            pendingTerminalActivationAttemptRef.current = null
          }
          return
        }
        applySessionTabs((response as RpcSuccess).result as SessionTabsResult)
        scheduleDelayedAction(() => void fetchSessionTabs(), 300)
        scheduleDelayedAction(() => void fetchSessionTabs(), 1200)
      })
      .catch(() => {
        if (pendingTerminalActivationAttemptRef.current === activationKey) {
          pendingTerminalActivationAttemptRef.current = null
        }
      })
  }, [
    activePendingTerminalTab,
    applySessionTabs,
    client,
    connState,
    fetchSessionTabs,
    scheduleDelayedAction,
    worktreeId
  ])
  return {
    bulkCloseActions,
    closeWithBulkActions,
    visibleTabs,
    activeMarkdownTab,
    activeFileTab,
    activeBrowserTab,
    activePendingTerminalTab,
    isPendingTerminalRecoveryParked,
    retryPendingTerminalRecovery
  }
}

export type MobileSessionBulkCloseModel = MobileSessionCloseActionsModel &
  ReturnType<typeof useMobileSessionBulkClose>
