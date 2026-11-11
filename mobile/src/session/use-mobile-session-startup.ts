import { useEffect } from 'react'
import { translate } from '../i18n/mobile-i18n'
import { worktreeActivate } from '../host-screen/host-screen-operations'
import { headlessActivationNeedsHostRenderer } from '../worktree/worktree-activation-result'
import { createInitialSessionAutoCreateState } from '../terminal/session/use-initial-session-terminal-autocreate'
import type { MobileSessionKeyboardStateModel } from '../terminal/session/use-mobile-session-keyboard-state'
import { withoutSessionTabHostOwnership } from './tabs/mobile-session-tab-status-clock'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'

export function useMobileSessionStartup(scope: MobileSessionKeyboardStateModel) {
  const {
    worktreeId,
    created,
    isFloatingWorkspaceRoute,
    connState,
    client,
    setTerminals,
    terminalsRef,
    setSessionTabs,
    readLastSessionTabs,
    watchLastSessionTabs,
    sessionTabsRef,
    appliedSnapshotMarkerRef,
    closedTabTombstonesRef,
    setTerminalsLoaded,
    setActiveHandle,
    setActiveSessionTabId,
    setMarkdownDocs,
    setFileDocs,
    terminalGestureInputQueuesRef,
    terminalGestureInputInFlightRef,
    sessionTabActionSheetKeyboardHideSubRef,
    sessionTabActionSheetRequestSeqRef,
    initializedHandlesRef,
    terminalResume,
    terminalDiagnosticsRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    pendingSelectionRef,
    selectedSessionTabIdRef,
    pendingBrowserFocusPageIdRef,
    pendingTerminalActivationAttemptRef,
    initialSessionAutoCreateRef,
    clearPendingLiveInputCommit,
    clearDelayedActionTimers,
    showToast,
    clearTerminalCache,
    setSplitTerminalHandles,
    terminalPaneViewportsRef,
    fetchTerminals,
    ensureSessionTabs
  } = scope
  useEffect(() => {
    // Reset reused-route state so the next workspace cannot inherit stale UI or snapshot gates.
    sessionTabActionSheetRequestSeqRef.current += 1
    sessionTabActionSheetKeyboardHideSubRef.current?.remove()
    sessionTabActionSheetKeyboardHideSubRef.current = null
    clearTerminalCache()
    setSplitTerminalHandles(null)
    terminalPaneViewportsRef.current.clear()
    activeHandleRef.current = null
    activeSessionTabTypeRef.current = null
    pendingSelectionRef.current = null
    selectedSessionTabIdRef.current = null
    pendingBrowserFocusPageIdRef.current = null
    pendingTerminalActivationAttemptRef.current = null
    initialSessionAutoCreateRef.current = createInitialSessionAutoCreateState()
    terminalDiagnosticsRef.current.resetRoute()
    appliedSnapshotMarkerRef.current = { epoch: null, version: -1 }
    closedTabTombstonesRef.current.clear()
    for (const queued of terminalGestureInputQueuesRef.current.values()) {
      if (queued.timer) {
        clearTimeout(queued.timer)
      }
    }
    terminalGestureInputQueuesRef.current.clear()
    terminalGestureInputInFlightRef.current.clear()
    setActiveHandle(null)
    setTerminals([])
    terminalsRef.current = []
    // Paint the last strip, from memory or the phone's store, until the host's snapshot replaces it (which treats
    // it as the previous strip). Nothing is active yet, so the body still says connecting or offline.
    const lastTabs = readLastSessionTabs()
    setSessionTabs(lastTabs ? withoutSessionTabHostOwnership(lastTabs) : [])
    // A strip read from the store after this mount (a slow boot read, an in-page open) still paints while
    // the host hasn't sent one and nothing is drawn.
    const stopLateTabs = lastTabs
      ? null
      : watchLastSessionTabs((tabs) => {
          stopLateTabs?.()
          if (
            appliedSnapshotMarkerRef.current.version === -1 &&
            sessionTabsRef.current.length === 0
          ) {
            setSessionTabs(withoutSessionTabHostOwnership([...tabs]))
          }
        })
    setActiveSessionTabId(null)
    clearPendingLiveInputCommit()
    setMarkdownDocs(new Map())
    setFileDocs(new Map())
    clearDelayedActionTimers()
    return () => {
      stopLateTabs?.()
      sessionTabActionSheetRequestSeqRef.current += 1
      sessionTabActionSheetKeyboardHideSubRef.current?.remove()
      clearPendingLiveInputCommit()
      clearDelayedActionTimers()
    }
  }, [
    clearDelayedActionTimers,
    clearPendingLiveInputCommit,
    clearTerminalCache,
    setSplitTerminalHandles,
    terminalPaneViewportsRef,
    readLastSessionTabs,
    watchLastSessionTabs
  ])

  // Every setTimeout goes through addTimer into `timers`, which the returned cleanup clears.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    if (connState !== 'connected') {
      return
    }
    // Keep xterm visible while reconnect history hydrates.
    const showsTerminalOutput =
      initializedHandlesRef.current.size > 0 ||
      terminalResume.holdsAny() ||
      terminalResume.anyCatchingUp()
    if (!showsTerminalOutput) {
      setTerminalsLoaded(false)
    }
    // Clear initialization so reconnect scrollback replaces stale content instead of being ignored.
    initializedHandlesRef.current.clear()
    let disposed = false
    const timers: ReturnType<typeof setTimeout>[] = []
    function addTimer(fn: () => void, ms: number) {
      if (disposed) {
        return
      }
      timers.push(setTimeout(fn, ms))
    }
    void (async () => {
      // Interpret only actual replies; preserve absent activation replies as null rather than inventing refusals.
      const reportActivationOutcome = (response: RpcResponse | null): void => {
        const activation = response === null ? null : worktreeActivate.interpret(response)
        if (
          !disposed &&
          activation?.accepted === true &&
          headlessActivationNeedsHostRenderer(activation.value)
        ) {
          showToast(
            translate(
              'session.useStartup.wakeAgents',
              'Open Orca on the host to wake sleeping agents.'
            ),
            3000
          )
        }
      }
      if (client && created !== '1' && !isFloatingWorkspaceRoute) {
        // Hydrate tabs without navigating other paired clients into this workspace.
        void worktreeActivate
          .request(client, {
            worktree: `id:${worktreeId}`,
            notifyClients: false,
            navigation: 'caller'
          })
          .then(reportActivationOutcome)
          .catch(() => null)
      }
      // Both join the focus refresh's in-flight reads; its 2 s tick re-lists while the tab stream is unconfirmed or a handle is pending.
      void ensureSessionTabs().catch(() => null)
      await fetchTerminals({ allowEmptyLoaded: false })
      if (disposed) {
        return
      }
      if (client && created === '1' && !isFloatingWorkspaceRoute) {
        addTimer(() => {
          if (activeHandleRef.current) {
            return
          }
          void (async () => {
            const activationResponse = await worktreeActivate
              .request(client, {
                worktree: `id:${worktreeId}`,
                notifyClients: false,
                navigation: 'caller'
              })
              .catch(() => null)
            reportActivationOutcome(activationResponse)
            if (disposed) {
              return
            }
            await fetchTerminals({ allowEmptyLoaded: true })
            addTimer(() => void fetchTerminals({ allowEmptyLoaded: true }), 750)
          })()
        }, 1800)
      }
    })()
    return () => {
      disposed = true
      for (const t of timers) {
        clearTimeout(t)
      }
    }
  }, [
    client,
    connState,
    created,
    fetchTerminals,
    ensureSessionTabs,
    isFloatingWorkspaceRoute,
    showToast,
    terminalResume,
    worktreeId
  ])
}
