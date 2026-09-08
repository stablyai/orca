import { useEffect, useRef, useCallback, useMemo, useState } from 'react'
import { runAcceptedMobileSessionTabsEffects } from './mobile-session-tabs-accepted-effects'
import type { SessionTabsStreamSource } from './mobile-session-tabs-stream-health'
import { useMobileSessionTabsFetchReporting } from './use-mobile-session-tabs-fetch-reporting'
import { useMobileSessionTabsReconciliation } from './use-mobile-session-tabs-reconciliation'
import { PendingTerminalHandleRecoveryContextCache } from './pending-terminal-handle-recovery'
import { hasConnectedTerminalAbsentFromSessionTabs } from './mobile-terminal-records'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'
import type { MobileSessionMarkdownActionsModel } from './use-mobile-session-markdown-actions'
import { startRuntimeCapabilityRead } from '../transport/runtime-capability-probe'

export function useMobileSessionTabReconciliation(scope: MobileSessionMarkdownActionsModel) {
  const {
    worktreeId,
    client,
    connState,
    sessionTabsRef,
    activeSessionTabIdRef,
    terminalsRef,
    appliedSessionTabsRevisionRef,
    closedTabTombstonesRef,
    setMarkdownDocs,
    terminalGestureInputQueuesRef,
    terminalGestureInputInFlightRef,
    terminalDiagnosticsRef,
    pendingBrowserFocusPageIdRef,
    switchSessionTabRef,
    nativeChatStream,
    fetchTerminals,
    applySessionTabs,
    terminalInventoryRecoveryScope,
    registerTerminalInventoryRecoveryAction,
    sessionTabOperations,
    setRuntimeCapabilitySnapshot
  } = scope
  const [parkedPendingTerminalContext, setParkedPendingTerminalContext] = useState<string | null>(
    null
  )
  const consumeAcceptedSessionTabs = useCallback(
    (
      _result: SessionTabsResult,
      effectiveTabs: readonly MobileSessionTab[],
      source: SessionTabsStreamSource
    ): void => {
      runAcceptedMobileSessionTabsEffects<MobileSessionTab>({
        effectiveTabs,
        source,
        getPendingBrowserPageId: () => pendingBrowserFocusPageIdRef.current,
        clearPendingBrowserPageId: (pageId) => {
          if (pendingBrowserFocusPageIdRef.current === pageId) {
            pendingBrowserFocusPageIdRef.current = null
          }
        },
        activateBrowserTab: (tab) => switchSessionTabRef.current?.(tab),
        markActiveMarkdownStale: (tabId) => {
          setMarkdownDocs((prev) => {
            const current = prev.get(tabId)
            if (current?.status !== 'ready' || current.isDirty) {
              return prev
            }
            return new Map(prev).set(tabId, { ...current, stale: true })
          })
        }
      })
    },
    []
  )
  const hasSessionTabsRecoveryNeed = useCallback(
    () =>
      closedTabTombstonesRef.current.size > 0 ||
      pendingBrowserFocusPageIdRef.current !== null ||
      hasConnectedTerminalAbsentFromSessionTabs(terminalsRef.current, sessionTabsRef.current) ||
      // Why: a chat-covered handle that ran out of rearms and left `terminal.list`
      // was reminted by a desktop graph reload. Only a fresh tab snapshot carries
      // the replacement handle, so force one instead of holding the composer locked.
      nativeChatStream.hasTabsRecoveryNeed(),
    [nativeChatStream]
  )
  const getSessionTabsApplicationRevision = useCallback(
    () => appliedSessionTabsRevisionRef.current,
    []
  )
  const pendingTerminalRecoveryContextCache = useMemo(
    () => new PendingTerminalHandleRecoveryContextCache(),
    []
  )
  const getPendingTerminalRecoveryContextKey = useCallback(
    () =>
      pendingTerminalRecoveryContextCache.read(
        sessionTabsRef.current,
        activeSessionTabIdRef.current
      ),
    [pendingTerminalRecoveryContextCache, sessionTabsRef, activeSessionTabIdRef]
  )
  const pendingTerminalRecoveryContextKey = getPendingTerminalRecoveryContextKey()
  const sessionTabsFetchReporting = useMobileSessionTabsFetchReporting<SessionTabsResult>({
    worktreeId,
    diagnosticsRef: terminalDiagnosticsRef
  })
  const {
    fetchSessionTabs,
    ensureSessionTabs,
    fetchPendingBrowserSessionTabs,
    retryPendingTerminalRecovery,
    requestTerminalInventoryRecovery
  } = useMobileSessionTabsReconciliation<SessionTabsResult, MobileSessionTab>({
    client,
    sessionTabOperations,
    connState,
    worktreeId,
    applySessionTabs,
    consumeAcceptedSessionTabs,
    fetchTerminals,
    terminalInventoryRecoveryScopeKey: terminalInventoryRecoveryScope,
    hasRecoveryNeed: hasSessionTabsRecoveryNeed,
    pendingTerminalRecoveryContextKey,
    getPendingTerminalRecoveryContextKey,
    onPendingTerminalRecoveryParked: setParkedPendingTerminalContext,
    getApplicationRevision: getSessionTabsApplicationRevision,
    ...sessionTabsFetchReporting
  })

  useEffect(
    () => registerTerminalInventoryRecoveryAction(requestTerminalInventoryRecovery),
    [registerTerminalInventoryRecoveryAction, requestTerminalInventoryRecovery]
  )

  useEffect(() => {
    if (connState === 'connected') {
      return
    }
    for (const queued of terminalGestureInputQueuesRef.current.values()) {
      if (queued.timer) {
        clearTimeout(queued.timer)
      }
    }
    terminalGestureInputQueuesRef.current.clear()
    terminalGestureInputInFlightRef.current.clear()
  }, [connState])

  const hostQueryReplyInputSupportedRef = useRef(false)

  useEffect(() => {
    if (!sessionTabOperations || connState !== 'connected') {
      hostQueryReplyInputSupportedRef.current = false
      return
    }
    hostQueryReplyInputSupportedRef.current = false
    // Why: the probe retries — a relay→direct cutover or request timeout rejects
    // status.get without changing connState, which used to latch these hidden.
    return startRuntimeCapabilityRead(
      () => sessionTabOperations.runtimeCapabilities(),
      (value) => {
        setRuntimeCapabilitySnapshot({
          operations: sessionTabOperations,
          browserScreencastSupported: value.browserScreencastSupported,
          agentSessionHistorySupported: value.agentHistorySupported,
          quickCommandsSupported: value.quickCommandsSupported
        })
        // Why: hosts without this capability strip inputKind from terminal.send,
        // so a forwarded xterm reply would become floor-stealing shell input.
        hostQueryReplyInputSupportedRef.current = value.terminalQueryReplyInputSupported
      }
    )
  }, [connState, sessionTabOperations])
  return {
    consumeAcceptedSessionTabs,
    hasSessionTabsRecoveryNeed,
    getSessionTabsApplicationRevision,
    sessionTabsFetchReporting,
    fetchSessionTabs,
    ensureSessionTabs,
    fetchPendingBrowserSessionTabs,
    retryPendingTerminalRecovery,
    requestTerminalInventoryRecovery,
    pendingTerminalRecoveryContextKey,
    parkedPendingTerminalContext,
    hostQueryReplyInputSupportedRef
  }
}

export type MobileSessionTabReconciliationModel = MobileSessionMarkdownActionsModel &
  ReturnType<typeof useMobileSessionTabReconciliation>
