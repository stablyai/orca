import { useEffect } from 'react'
import {
  createBulkCloseSheetActions,
  createCloseWithBulkActions
} from './mobile-bulk-close-sheet-actions'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionCloseActionsModel } from './use-mobile-session-close-actions'

export function useMobileSessionBulkClose(scope: MobileSessionCloseActionsModel) {
  const {
    worktreeId,
    connState,
    sessionTabs,
    sessionTabsRef,
    activeSessionTabIdRef,
    markdownDocs,
    pendingTerminalActivationAttemptRef,
    activeSessionTab,
    scheduleDelayedAction,
    fetchSessionTabs,
    switchSessionTab,
    handleCloseSessionTab,
    pendingTerminalRecoveryContextKey,
    parkedPendingTerminalContext,
    retryPendingTerminalRecovery,
    activateSessionTab,
    sessionTabOperations
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
    if (!sessionTabOperations || connState !== 'connected' || !activePendingTerminalTab) {
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
    void activateSessionTab(activePendingTerminalTab.id, activePendingTerminalTab.leafId)
      .then((activated) => {
        if (!activated) {
          if (pendingTerminalActivationAttemptRef.current === activationKey) {
            pendingTerminalActivationAttemptRef.current = null
          }
          return
        }
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
    activateSessionTab,
    connState,
    fetchSessionTabs,
    scheduleDelayedAction,
    sessionTabOperations,
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
