import { useEffect, useState } from 'react'
import {
  createBulkCloseSheetActions,
  createCloseWithBulkActions
} from './mobile-bulk-close-sheet-actions'
import type { RpcSuccess } from '../../transport/rpc/rpc-wire-types'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { activateMobileSessionTab } from './mobile-session-tab-activation'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-tabs'
import type { MobileSessionCloseActionsModel } from './use-mobile-session-close-actions'

export function useMobileSessionBulkClose(scope: MobileSessionCloseActionsModel) {
  const t = useMobileTranslation()
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
  const [answerBulkClose, setAnswerBulkClose] = useState<((confirmed: boolean) => void) | null>(
    null
  )
  // Kept once answered, so the confirm's words hold still while it slides away.
  const [bulkCloseCount, setBulkCloseCount] = useState(0)
  const resolveBulkCloseConfirm = (confirmed: boolean) => {
    answerBulkClose?.(confirmed)
    setAnswerBulkClose(null)
  }
  const bulkCloseConfirm = {
    visible: answerBulkClose !== null,
    title:
      bulkCloseCount === 1
        ? t('session.bulkTabClose.titleOthers_one', 'Close {{count}} other tab?', {
            count: bulkCloseCount
          })
        : t('session.bulkTabClose.titleOthers_other', 'Close {{count}} other tabs?', {
            count: bulkCloseCount
          }),
    confirmLabel:
      bulkCloseCount === 1
        ? t('session.bulkTabClose.confirm_one', 'Close {{count}} tab', { count: bulkCloseCount })
        : t('session.bulkTabClose.confirm_other', 'Close {{count}} tabs', {
            count: bulkCloseCount
          }),
    destructive: true,
    onConfirm: () => resolveBulkCloseConfirm(true),
    onCancel: () => resolveBulkCloseConfirm(false)
  }
  const bulkCloseActions = createBulkCloseSheetActions({
    sessionTabsRef,
    markdownDocs,
    activeSessionTabIdRef,
    switchSessionTab,
    closeSessionTab: handleCloseSessionTab,
    confirmBulkClose: (count) =>
      new Promise<boolean>((resolve) => {
        setBulkCloseCount(count)
        setAnswerBulkClose(() => resolve)
      })
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
    // Pending server-owned tabs need activation to materialize their PTY handles.
    pendingTerminalActivationAttemptRef.current = activationKey
    void activateMobileSessionTab(client, {
      worktree: `id:${worktreeId}`,
      tabId: activePendingTerminalTab.id,
      leafId: activePendingTerminalTab.leafId,
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })
      .then((response) => {
        // A route reset or another attempt replaced this one; its tabs belong to that older route.
        if (pendingTerminalActivationAttemptRef.current !== activationKey) {
          return
        }
        if (!response.ok) {
          pendingTerminalActivationAttemptRef.current = null
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
    bulkCloseConfirm,
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
