import { useCallback, useEffect, useMemo } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  MobileSessionTabsStreamHealth,
  type SessionTabsApplyOutcome,
  type SessionTabsStreamSource
} from './mobile-session-tabs-stream-health'

type Params<Result, Tab> = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  applySessionTabs: (result: Result) => SessionTabsApplyOutcome<Tab>
  consumeAcceptedSessionTabs: (
    result: Result,
    effectiveTabs: readonly Tab[],
    source: SessionTabsStreamSource
  ) => void
  fetchTerminals: () => Promise<void>
  hasRecoveryNeed: () => boolean
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
}

const resolved = Promise.resolve()

export function useMobileSessionTabsReconciliation<Result, Tab>({
  client,
  connState,
  worktreeId,
  applySessionTabs,
  consumeAcceptedSessionTabs,
  fetchTerminals,
  hasRecoveryNeed,
  getApplicationRevision,
  onFetchStarted,
  onFetchSucceeded,
  onFetchFailed,
  onFetchErrored
}: Params<Result, Tab>): ResultActions {
  const controller = useMemo(
    () =>
      client
        ? new MobileSessionTabsStreamHealth<Result, Tab>({
            client,
            scope: `id:${worktreeId}`,
            apply: applySessionTabs,
            consumeAccepted: consumeAcceptedSessionTabs,
            hasRecoveryNeed,
            getApplicationRevision,
            onFetchStarted,
            onFetchSucceeded,
            onFetchFailed: (failure) => onFetchFailed?.(failure.error.code),
            onFetchErrored
          })
        : null,
    [
      applySessionTabs,
      client,
      consumeAcceptedSessionTabs,
      getApplicationRevision,
      hasRecoveryNeed,
      onFetchErrored,
      onFetchFailed,
      onFetchStarted,
      onFetchSucceeded,
      worktreeId
    ]
  )

  useEffect(
    () => () => {
      controller?.dispose()
    },
    [controller]
  )

  useEffect(() => {
    if (!client || !controller || connState !== 'connected') {
      return
    }
    const subscription = controller.beginSubscription()
    const unsubscribe = client.subscribe(
      'session.tabs.subscribe',
      { worktree: `id:${worktreeId}` },
      subscription.listener
    )
    return () => {
      subscription.cancel()
      unsubscribe()
    }
  }, [client, connState, controller, worktreeId])

  useFocusEffect(
    useCallback(() => {
      if (!controller || connState !== 'connected') {
        return
      }
      const refresh = (forceTabs: boolean): void => {
        if (AppState.currentState !== 'active') {
          controller.setReconciliationActive(false)
          return
        }
        controller.setReconciliationActive(true)
        if (forceTabs) {
          void controller.requestReconciliation()
        } else {
          void controller.poll()
        }
        void fetchTerminals()
      }
      const appStateSubscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          refresh(true)
        } else {
          controller.setReconciliationActive(false)
        }
      })
      const interval = setInterval(() => refresh(false), 2000)
      refresh(true)
      return () => {
        controller.setReconciliationActive(false)
        clearInterval(interval)
        appStateSubscription.remove()
      }
    }, [connState, controller, fetchTerminals])
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
    )
  }
}
