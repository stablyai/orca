import { useEffect } from 'react'
import { worktreeActivate } from '../host-screen/host-screen-operations'
import { headlessActivationNeedsHostRenderer } from '../worktree/worktree-activation-result'
import { createInitialSessionAutoCreateState } from './use-initial-session-terminal-autocreate'
import type { MobileSessionKeyboardStateModel } from './use-mobile-session-keyboard-state'
import type { RpcResponse } from '../transport/types'

export function useMobileSessionStartup(scope: MobileSessionKeyboardStateModel) {
  const {
    hostId,
    worktreeId,
    created,
    isFloatingWorkspaceRoute,
    connState,
    client,
    setTerminals,
    terminalsRef,
    setSessionTabs,
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
    terminalDiagnosticsRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    pendingActiveSessionTabIdRef,
    selectedSessionTabIdRef,
    pendingActiveTerminalHandleRef,
    pendingBrowserFocusPageIdRef,
    pendingTerminalActivationAttemptRef,
    initialSessionAutoCreateRef,
    bufferedTerminalDraftState,
    clearPendingLiveInputCommit,
    clearDelayedActionTimers,
    showToast,
    clearTerminalCache,
    fetchTerminals,
    ensureSessionTabs
  } = scope
  useEffect(() => {
    // Why: Expo reuses this screen across worktrees; reset route state so it can't open stale UI or reject the next snapshot.
    sessionTabActionSheetRequestSeqRef.current += 1
    sessionTabActionSheetKeyboardHideSubRef.current?.remove()
    sessionTabActionSheetKeyboardHideSubRef.current = null
    clearTerminalCache()
    activeHandleRef.current = null
    activeSessionTabTypeRef.current = null
    pendingActiveSessionTabIdRef.current = null
    selectedSessionTabIdRef.current = null
    pendingActiveTerminalHandleRef.current = null
    pendingBrowserFocusPageIdRef.current = null
    pendingTerminalActivationAttemptRef.current = null
    initialSessionAutoCreateRef.current = createInitialSessionAutoCreateState()
    terminalDiagnosticsRef.current.resetRoute()
    appliedSnapshotMarkerRef.current = { epoch: null, version: -1 }
    closedTabTombstonesRef.current.clear()
    bufferedTerminalDraftState.resetDrafts()
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
    setSessionTabs([])
    setActiveSessionTabId(null)
    clearPendingLiveInputCommit()
    setMarkdownDocs(new Map())
    setFileDocs(new Map())
    clearDelayedActionTimers()
    return () => {
      sessionTabActionSheetRequestSeqRef.current += 1
      sessionTabActionSheetKeyboardHideSubRef.current?.remove()
      bufferedTerminalDraftState.clearPendingRestorations()
      clearPendingLiveInputCommit()
      clearDelayedActionTimers()
    }
  }, [
    clearDelayedActionTimers,
    clearPendingLiveInputCommit,
    bufferedTerminalDraftState.clearPendingRestorations,
    clearTerminalCache,
    hostId,
    bufferedTerminalDraftState.resetDrafts,
    worktreeId
  ])

  // Every setTimeout goes through addTimer into `timers`, which the returned cleanup clears.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    if (connState !== 'connected') {
      return
    }
    // Why: keep the current xterm visible while the reconnect snapshot hydrates, not a blank "Loading terminals" surface.
    if (initializedHandlesRef.current.size === 0) {
      setTerminalsLoaded(false)
    }
    // Why: clear the initialized flag so the reconnect scrollback replaces stale content instead of being dropped.
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
      // Why the reply rather than a verdict: both activations report through here, and only one of
      // them can fail to get a reply at all. Interpreting inside keeps the absent case spelled
      // `null` instead of a hand-built refusal that has to stay in step with the operation.
      const reportActivationOutcome = (response: RpcResponse | null): void => {
        const activation = response === null ? null : worktreeActivate.interpret(response)
        if (
          !disposed &&
          activation?.accepted === true &&
          headlessActivationNeedsHostRenderer(activation.value)
        ) {
          showToast('Open Orca on the host to wake sleeping agents.', 3000)
        }
      }
      if (client && created !== '1' && !isFloatingWorkspaceRoute) {
        // Why: hydrate host-owned tabs without pulling other paired clients (esp. desktop) into this worktree.
        void worktreeActivate
          .request(client, {
            worktree: `id:${worktreeId}`,
            notifyClients: false,
            navigation: 'caller'
          })
          .then(reportActivationOutcome)
          .catch(() => null)
      }
      if (disposed) {
        return
      }
      await ensureSessionTabs().catch(() => null)
      if (disposed) {
        return
      }
      await fetchTerminals({ allowEmptyLoaded: false })
      if (disposed) {
        return
      }
      addTimer(() => void fetchTerminals({ allowEmptyLoaded: false }), 750)
      addTimer(() => void fetchTerminals({ allowEmptyLoaded: true }), 1500)
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
    worktreeId
  ])
}
