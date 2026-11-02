import { useCallback, useEffect, useState } from 'react'
import {
  createBulkCloseSheetActions,
  createCloseWithBulkActions
} from './mobile-bulk-close-sheet-actions'
import type { RpcSuccess } from '../transport/types'
import { mobileBulkTabCloseCopy } from './mobile-bulk-tab-close-copy'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { activateMobileSessionTab } from './mobile-session-tab-activation'
import {
  computeSessionTabReorderPlan,
  requestMobileSessionTabMove
} from './mobile-session-tab-reorder'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'
import type { MobileSessionCloseActionsModel } from './use-mobile-session-close-actions'

export function useMobileSessionBulkClose(scope: MobileSessionCloseActionsModel) {
  const t = useMobileTranslation()
  const copy = mobileBulkTabCloseCopy(t)
  const {
    worktreeId,
    client,
    connState,
    sessionTabs,
    setSessionTabs,
    sessionTabsRef,
    sessionTabGroupsRef,
    activeSessionGroupIdRef,
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
  const executeTabReorderPlan = useCallback(
    (plan: NonNullable<ReturnType<typeof computeSessionTabReorderPlan>>): boolean => {
      sessionTabsRef.current = plan.reorderedTabs
      sessionTabGroupsRef.current = plan.reorderedTabGroups
      setSessionTabs(plan.reorderedTabs)
      if (!client || connState !== 'connected') {
        return true
      }
      void requestMobileSessionTabMove(client, {
        worktree: `id:${worktreeId}`,
        ...plan.rpcMove
      })
        .then((response) => {
          if (!response.ok) {
            void fetchSessionTabs()
            return
          }
          const result = (response as RpcSuccess).result as SessionTabsResult | undefined
          if (result && Array.isArray(result.tabs)) {
            applySessionTabs(result)
          }
        })
        .catch(() => {
          void fetchSessionTabs()
        })
      return true
    },
    [
      applySessionTabs,
      client,
      connState,
      fetchSessionTabs,
      sessionTabGroupsRef,
      sessionTabsRef,
      setSessionTabs,
      worktreeId
    ]
  )
  const reorderSessionTab = useCallback(
    (tabId: string, targetBlockIndex: number): boolean => {
      const plan = computeSessionTabReorderPlan({
        tabs: sessionTabsRef.current,
        tabGroups: sessionTabGroupsRef.current,
        activeGroupId: activeSessionGroupIdRef.current,
        tabId,
        targetBlockIndex
      })
      if (!plan) {
        return false
      }
      return executeTabReorderPlan(plan)
    },
    [activeSessionGroupIdRef, executeTabReorderPlan, sessionTabGroupsRef, sessionTabsRef]
  )
  const moveSessionTabByOffset = useCallback(
    (tabId: string, delta: -1 | 1): boolean => {
      const plan = computeSessionTabReorderPlan({
        tabs: sessionTabsRef.current,
        tabGroups: sessionTabGroupsRef.current,
        activeGroupId: activeSessionGroupIdRef.current,
        tabId,
        delta
      })
      if (!plan) {
        return false
      }
      return executeTabReorderPlan(plan)
    },
    [activeSessionGroupIdRef, executeTabReorderPlan, sessionTabGroupsRef, sessionTabsRef]
  )
  const [answerBulkClose, setAnswerBulkClose] = useState<((confirmed: boolean) => void) | null>(
    null
  )
  const resolveBulkCloseConfirm = (confirmed: boolean) => {
    answerBulkClose?.(confirmed)
    setAnswerBulkClose(null)
  }
  const bulkCloseConfirm = {
    visible: answerBulkClose !== null,
    title: copy.title.others,
    message: copy.description,
    confirmLabel: copy.confirm,
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
    confirmBulkClose: () => new Promise<boolean>((resolve) => setAnswerBulkClose(() => resolve)),
    moveTabByOffset: (tabId, delta) => {
      moveSessionTabByOffset(tabId, delta)
    }
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
    bulkCloseConfirm,
    closeWithBulkActions,
    reorderSessionTab,
    moveSessionTabByOffset,
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
