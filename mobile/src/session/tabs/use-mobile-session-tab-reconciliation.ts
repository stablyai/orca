import { useEffect, useRef, useCallback, useMemo, useState } from 'react'
import { startRuntimeCapabilityProbe } from '../../transport/connection/runtime-capability-probe'
import { supportsMobileQuickCommands } from '../../terminal/quick-commands/quick-commands'
import { terminalQuickCommandAgentPromptMaxLength } from '../../../../src/shared/terminal/quick-commands/terminal-quick-command-prompt-limit'
import { MOBILE_AI_VAULT_CAPABILITY } from '../../agent-history/agent-history-capability'
import '../../../../src/shared/protocol-version'
import { TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY } from '../../../../src/shared/terminal/runtime-policy/terminal-runtime-capabilities'
import { PROGRAM_STATUS_RUNTIME_CAPABILITY } from '../../../../src/shared/program-status/protocol'
import { structuredAgentSessionHostSupport } from '../native-chat/agent-session/mobile-structured-agent-session-host-support'
import { runAcceptedMobileSessionTabsEffects } from './mobile-session-tabs-accepted-effects'
import type { SessionTabsStreamSource } from './mobile-session-tabs-stream-health'
import { useMobileSessionTabsFetchReporting } from './use-mobile-session-tabs-fetch-reporting'
import { useMobileSessionTabsReconciliation } from './use-mobile-session-tabs-reconciliation'
import { PendingTerminalHandleRecoveryContextCache } from '../../terminal/session/pending-terminal-handle-recovery'
import { hasConnectedTerminalAbsentFromSessionTabs } from '../../terminal/session/mobile-terminal-records'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-tabs'
import type { MobileSessionMarkdownActionsModel } from '../../files/session-documents/use-mobile-session-markdown-actions'
import { withoutSessionTabHostOwnership } from './mobile-session-tab-status-clock'
import { useMobileSessionLastTabs } from './mobile-session-last-tabs'

export function useMobileSessionTabReconciliation(scope: MobileSessionMarkdownActionsModel) {
  const {
    hostId,
    worktreeId,
    client,
    connState,
    sessionTabsRef,
    setSessionTabs,
    activeSessionTabIdRef,
    terminalsRef,
    appliedSessionTabsRevisionRef,
    closedTabTombstonesRef,
    setMarkdownDocs,
    setShowQuickCommands,
    terminalGestureInputQueuesRef,
    terminalGestureInputInFlightRef,
    terminalDiagnosticsRef,
    pendingBrowserFocusPageIdRef,
    switchSessionTabRef,
    setBrowserScreencastSupported,
    setAgentSessionHistorySupported,
    setAgentSessionHostSupport,
    setQuickCommandsSupported,
    setQuickCommandAgentPromptMaxLength,
    nativeChatStream,
    fetchTerminals,
    applySessionTabs,
    terminalInventoryRecoveryScope,
    registerTerminalInventoryRecoveryAction
  } = scope
  const [parkedPendingTerminalContext, setParkedPendingTerminalContext] = useState<string | null>(
    null
  )
  const {
    readLastSessionTabs,
    watchLastSessionTabs,
    rememberLastSessionTabs,
    forgetLastSessionTab
  } = useMobileSessionLastTabs(hostId, worktreeId)
  const consumeAcceptedSessionTabs = useCallback(
    (
      _result: SessionTabsResult,
      effectiveTabs: readonly MobileSessionTab[],
      source: SessionTabsStreamSource
    ): void => {
      // Only host-accepted strips; the controller is per worktree, so the key is always this snapshot's.
      rememberLastSessionTabs(effectiveTabs)
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
    [rememberLastSessionTabs]
  )
  const hasSessionTabsRecoveryNeed = useCallback(
    () =>
      closedTabTombstonesRef.current.size > 0 ||
      pendingBrowserFocusPageIdRef.current !== null ||
      hasConnectedTerminalAbsentFromSessionTabs(terminalsRef.current, sessionTabsRef.current) ||
      // Exhausted/absent chat handles need a fresh tab snapshot to discover the graph reload’s replacement.
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

  useEffect(() => {
    if (connState === 'connected') {
      return
    }
    const revoked = withoutSessionTabHostOwnership(sessionTabsRef.current)
    if (revoked !== sessionTabsRef.current) {
      sessionTabsRef.current = revoked
      setSessionTabs(revoked)
    }
  }, [connState, sessionTabsRef, setSessionTabs])

  const hostQueryReplyInputSupportedRef = useRef(false)
  const hostProgramStatusSupportedRef = useRef(false)

  useEffect(() => {
    if (!client || connState !== 'connected') {
      setBrowserScreencastSupported(null)
      setAgentSessionHistorySupported(null)
      setAgentSessionHostSupport(null)
      setQuickCommandsSupported(null)
      setQuickCommandAgentPromptMaxLength(null)
      setShowQuickCommands(false)
      hostQueryReplyInputSupportedRef.current = false
      hostProgramStatusSupportedRef.current = false
      return
    }
    // A client swap may reach an older host without disconnecting the route; clear capabilities before showing host-specific actions.
    setBrowserScreencastSupported(null)
    setAgentSessionHistorySupported(null)
    setAgentSessionHostSupport(null)
    setQuickCommandsSupported(null)
    setQuickCommandAgentPromptMaxLength(null)
    setShowQuickCommands(false)
    hostQueryReplyInputSupportedRef.current = false
    hostProgramStatusSupportedRef.current = false
    // Retry status after cutover/timeouts even when connection state never changes or features can remain hidden forever.
    return startRuntimeCapabilityProbe(client, (capabilities) => {
      setBrowserScreencastSupported(capabilities.includes('browser.screencast.v1'))
      setAgentSessionHistorySupported(capabilities.includes(MOBILE_AI_VAULT_CAPABILITY))
      setAgentSessionHostSupport(structuredAgentSessionHostSupport(capabilities))
      setQuickCommandsSupported(supportsMobileQuickCommands(capabilities))
      setQuickCommandAgentPromptMaxLength(terminalQuickCommandAgentPromptMaxLength(capabilities))
      // Older hosts discard inputKind, turning forwarded xterm replies into floor-stealing shell input.
      hostQueryReplyInputSupportedRef.current = capabilities.includes(
        TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY
      )
      hostProgramStatusSupportedRef.current = capabilities.includes(
        PROGRAM_STATUS_RUNTIME_CAPABILITY
      )
    })
  }, [client, connState])
  return {
    readLastSessionTabs,
    watchLastSessionTabs,
    forgetLastSessionTab,
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
    hostQueryReplyInputSupportedRef,
    hostProgramStatusSupportedRef
  }
}

export type MobileSessionTabReconciliationModel = MobileSessionMarkdownActionsModel &
  ReturnType<typeof useMobileSessionTabReconciliation>
