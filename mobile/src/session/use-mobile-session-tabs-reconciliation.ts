import { useCallback, useEffect, useMemo, useRef } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { HostSessionTabOperations } from './host-session-tab-operations'
import {
  MobileSessionTabsStreamHealth,
  type SessionTabsApplyOutcome,
  type SessionTabsStreamSource
} from './mobile-session-tabs-stream-health'
import { PendingTerminalHandleRecoveryBudget } from './pending-terminal-handle-recovery'
import {
  useMobileTerminalInventoryRecovery,
  type MobileTerminalInventoryRefreshOptions
} from './use-mobile-terminal-inventory-recovery'

type Params<Result, Tab> = {
  client: RpcClient | null
  sessionTabOperations?: HostSessionTabOperations | null
  connState: ConnectionState
  worktreeId: string
  applySessionTabs: (result: Result) => SessionTabsApplyOutcome<Tab>
  consumeAcceptedSessionTabs: (
    result: Result,
    effectiveTabs: readonly Tab[],
    source: SessionTabsStreamSource
  ) => void
  fetchTerminals: (options?: MobileTerminalInventoryRefreshOptions) => Promise<boolean>
  terminalInventoryRecoveryScopeKey: string
  hasRecoveryNeed: () => boolean
  pendingTerminalRecoveryContextKey?: string | null
  getPendingTerminalRecoveryContextKey?: () => string | null
  onPendingTerminalRecoveryParked?: (contextKey: string | null) => void
  getApplicationRevision?: () => number
  onFetchStarted?: () => void
  onFetchSucceeded?: (result: Result) => void
  onFetchFailed?: (code: string) => void
  onFetchErrored?: (error: unknown) => void
}

type ResultActions = {
  fetchSessionTabs: () => Promise<void>
  ensureSessionTabs: () => Promise<void>
  fetchPendingBrowserSessionTabs: () => Promise<void>
  retryPendingTerminalRecovery: () => Promise<void>
  requestTerminalInventoryRecovery: () => void
}

const resolved = Promise.resolve()
const RECONCILIATION_INTERVAL_MS = 2000

export function useMobileSessionTabsReconciliation<Result, Tab>({
  client,
  sessionTabOperations,
  connState,
  worktreeId,
  applySessionTabs,
  consumeAcceptedSessionTabs,
  fetchTerminals,
  terminalInventoryRecoveryScopeKey,
  hasRecoveryNeed,
  pendingTerminalRecoveryContextKey,
  getPendingTerminalRecoveryContextKey,
  onPendingTerminalRecoveryParked,
  getApplicationRevision,
  onFetchStarted,
  onFetchSucceeded,
  onFetchFailed,
  onFetchErrored
}: Params<Result, Tab>): ResultActions {
  const pendingTerminalRecoveryBudget = useMemo(() => new PendingTerminalHandleRecoveryBudget(), [])
  const onPendingTerminalRecoveryParkedRef = useRef(onPendingTerminalRecoveryParked)
  // Why: only poll/reset callbacks read this, and they run after commit — so writing it in
  // render would let a discarded render leak a callback that never mounted.
  useEffect(() => {
    onPendingTerminalRecoveryParkedRef.current = onPendingTerminalRecoveryParked
  })
  const combinedHasRecoveryNeed = useCallback(() => {
    const contextKey = getPendingTerminalRecoveryContextKey?.() ?? null
    pendingTerminalRecoveryBudget.observeContext(contextKey)
    return hasRecoveryNeed() || contextKey !== null
  }, [getPendingTerminalRecoveryContextKey, hasRecoveryNeed, pendingTerminalRecoveryBudget])
  const allowRecoveryPoll = useCallback(() => {
    if (hasRecoveryNeed()) {
      return true
    }
    const contextKey = getPendingTerminalRecoveryContextKey?.() ?? null
    const attempt = pendingTerminalRecoveryBudget.take(contextKey)
    if (attempt.parked) {
      onPendingTerminalRecoveryParkedRef.current?.(contextKey)
    }
    return attempt.allowed
  }, [getPendingTerminalRecoveryContextKey, hasRecoveryNeed, pendingTerminalRecoveryBudget])
  const resetPendingTerminalRecovery = useCallback(() => {
    pendingTerminalRecoveryBudget.reset()
    onPendingTerminalRecoveryParkedRef.current?.(null)
  }, [pendingTerminalRecoveryBudget])
  useEffect(() => {
    pendingTerminalRecoveryBudget.observeContext(pendingTerminalRecoveryContextKey ?? null)
    onPendingTerminalRecoveryParkedRef.current?.(null)
  }, [pendingTerminalRecoveryBudget, pendingTerminalRecoveryContextKey])

  const controller = useMemo(() => {
    if (!sessionTabOperations && !client) {
      return null
    }
    return new MobileSessionTabsStreamHealth<Result, Tab>({
      ...(sessionTabOperations
        ? {
            requestSnapshot: () => sessionTabOperations.snapshot(worktreeId) as Promise<Result>,
            getGeneration: () =>
              (
                client as (RpcClient & { getGeneration?: () => number }) | null
              )?.getGeneration?.() ?? 0
          }
        : { client: client as RpcClient, scope: `id:${worktreeId}` }),
      apply: applySessionTabs,
      consumeAccepted: consumeAcceptedSessionTabs,
      hasRecoveryNeed: combinedHasRecoveryNeed,
      allowRecoveryPoll: getPendingTerminalRecoveryContextKey ? allowRecoveryPoll : undefined,
      getApplicationRevision,
      onFetchStarted,
      onFetchSucceeded,
      onFetchFailed: (failure) => onFetchFailed?.(failure.error.code),
      onFetchErrored
    })
  }, [
    applySessionTabs,
    client,
    consumeAcceptedSessionTabs,
    getApplicationRevision,
    allowRecoveryPoll,
    combinedHasRecoveryNeed,
    getPendingTerminalRecoveryContextKey,
    onFetchErrored,
    onFetchFailed,
    onFetchStarted,
    onFetchSucceeded,
    sessionTabOperations,
    worktreeId
  ])

  const {
    activateTerminalInventoryRecovery,
    isCertifiedTerminalSweepDue,
    refreshTerminalInventory,
    requestTerminalInventoryRecovery,
    resetCertifiedTerminalSweep,
    resumePendingTerminalInventoryRecovery,
    suspendTerminalInventoryRecovery
  } = useMobileTerminalInventoryRecovery({
    client,
    connState,
    fetchTerminals,
    scopeKey: terminalInventoryRecoveryScopeKey
  })

  useEffect(
    () => () => {
      suspendTerminalInventoryRecovery(true)
      controller?.dispose()
    },
    [controller, suspendTerminalInventoryRecovery]
  )

  useEffect(() => {
    if ((!sessionTabOperations && !client) || !controller || connState !== 'connected') {
      return
    }
    resetPendingTerminalRecovery()
    const subscription = controller.beginSubscription()
    if (sessionTabOperations) {
      let initialSnapshotPending = true
      const unsubscribe = sessionTabOperations.subscribe(
        worktreeId,
        (snapshot) => {
          const type = initialSnapshotPending ? 'snapshot' : 'updated'
          initialSnapshotPending = false
          subscription.listener({ ...snapshot, type } as Result)
        },
        () => subscription.listener({ type: 'error' } as Result)
      )
      return () => {
        subscription.cancel()
        unsubscribe()
      }
    }
    const directClient = client as RpcClient
    const unsubscribe = directClient.subscribe(
      'session.tabs.subscribe',
      { worktree: `id:${worktreeId}` },
      subscription.listener
    )
    return () => {
      subscription.cancel()
      unsubscribe()
    }
  }, [
    client,
    connState,
    controller,
    resetPendingTerminalRecovery,
    sessionTabOperations,
    worktreeId
  ])

  useFocusEffect(
    useCallback(() => {
      if (!controller || connState !== 'connected') {
        suspendTerminalInventoryRecovery(true)
        return
      }
      activateTerminalInventoryRecovery()
      resetCertifiedTerminalSweep()
      const refresh = (forceTabs: boolean): void => {
        if (AppState.currentState !== 'active') {
          suspendTerminalInventoryRecovery(true)
          controller.setReconciliationActive(false)
          return
        }
        activateTerminalInventoryRecovery()
        controller.setReconciliationActive(true)
        const tabsRequest = forceTabs ? controller.requestReconciliation() : controller.poll()
        const now = Date.now()
        // Why: healthy tab streams own liveness; retain only a slow inventory sweep for stale handles and metadata.
        if (forceTabs || tabsRequest !== null || isCertifiedTerminalSweepDue(now)) {
          void refreshTerminalInventory()
        }
        resumePendingTerminalInventoryRecovery()
      }
      const appStateSubscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          activateTerminalInventoryRecovery()
          resetPendingTerminalRecovery()
          refresh(true)
        } else {
          suspendTerminalInventoryRecovery(true)
          controller.setReconciliationActive(false)
        }
      })
      const interval = setInterval(() => refresh(false), RECONCILIATION_INTERVAL_MS)
      resetPendingTerminalRecovery()
      refresh(true)
      return () => {
        suspendTerminalInventoryRecovery(true)
        controller.setReconciliationActive(false)
        clearInterval(interval)
        appStateSubscription.remove()
      }
    }, [
      activateTerminalInventoryRecovery,
      connState,
      controller,
      isCertifiedTerminalSweepDue,
      refreshTerminalInventory,
      resetPendingTerminalRecovery,
      resetCertifiedTerminalSweep,
      resumePendingTerminalInventoryRecovery,
      suspendTerminalInventoryRecovery
    ])
  )

  return {
    fetchSessionTabs: useCallback(
      () => controller?.requestReconciliation() ?? resolved,
      [controller]
    ),
    ensureSessionTabs: useCallback(
      () => controller?.ensureReconciliation() ?? resolved,
      [controller]
    ),
    fetchPendingBrowserSessionTabs: useCallback(
      () => controller?.requestPendingRecovery() ?? resolved,
      [controller]
    ),
    retryPendingTerminalRecovery: useCallback(() => {
      resetPendingTerminalRecovery()
      return controller?.retryReconciliation() ?? resolved
    }, [controller, resetPendingTerminalRecovery]),
    requestTerminalInventoryRecovery
  }
}
