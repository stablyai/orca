import { useEffect, useRef } from 'react'
import type { RpcSuccess } from '../transport/types'
import { headlessActivationNeedsHostRenderer } from '../worktree/worktree-activation-result'
import { createInitialSessionAutoCreateState } from './use-initial-session-terminal-autocreate'
import type { MobileSessionKeyboardStateModel } from './use-mobile-session-keyboard-state'

export function useMobileSessionStartup(scope: MobileSessionKeyboardStateModel) {
  const {
    hostId,
    worktreeId,
    created,
    isFloatingWorkspaceRoute,
    connState,
    client,
    statusPending,
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
  // Holds the in-flight tab/terminal hydration so the activation effect can wait on it.
  const hydrationRef = useRef<Promise<void> | null>(null)
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
    hydrationRef.current = (async () => {
      // Why: independent host reads; serialising them cost a whole extra round trip on every connect.
      await Promise.all([
        ensureSessionTabs().catch(() => null),
        fetchTerminals({ allowEmptyLoaded: false })
      ])
      if (disposed) {
        return
      }
      addTimer(() => void fetchTerminals({ allowEmptyLoaded: false }), 750)
      addTimer(() => void fetchTerminals({ allowEmptyLoaded: true }), 1500)
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

  // Why: activate writes host state, so it waits for the compat verdict to settle; a blocked
  // verdict unmounts this route before the effect can run.
  // Every setTimeout goes through addTimer into `timers`, which the returned cleanup clears.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    if (statusPending || connState !== 'connected' || !client || isFloatingWorkspaceRoute) {
      return
    }
    let disposed = false
    const timers: ReturnType<typeof setTimeout>[] = []
    function addTimer(fn: () => void, ms: number) {
      if (disposed) {
        return
      }
      timers.push(setTimeout(fn, ms))
    }
    const reportActivationOutcome = (response: RpcSuccess | null): void => {
      if (!disposed && response && headlessActivationNeedsHostRenderer(response.result)) {
        showToast('Open Orca on the host to wake sleeping agents.', 3000)
      }
    }
    if (created !== '1') {
      // Why: hydrate host-owned tabs without pulling other paired clients (esp. desktop) into this worktree.
      void client
        .sendRequest('worktree.activate', {
          worktree: `id:${worktreeId}`,
          notifyClients: false,
          navigation: 'caller'
        })
        .then((response) => reportActivationOutcome(response.ok ? response : null))
        .catch(() => null)
    } else {
      // Why: hydration can claim the active handle and consume `created`; arming the recovery
      // before it settles would let this route send a second activate once `created` clears.
      void (async () => {
        await hydrationRef.current
        if (disposed) {
          return
        }
        addTimer(() => {
          if (activeHandleRef.current) {
            return
          }
          void (async () => {
            const activationResponse = await client
              .sendRequest('worktree.activate', {
                worktree: `id:${worktreeId}`,
                notifyClients: false,
                navigation: 'caller'
              })
              .catch(() => null)
            reportActivationOutcome(activationResponse?.ok ? activationResponse : null)
            if (disposed) {
              return
            }
            await fetchTerminals({ allowEmptyLoaded: true })
            addTimer(() => void fetchTerminals({ allowEmptyLoaded: true }), 750)
          })()
        }, 1800)
      })()
    }
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
    isFloatingWorkspaceRoute,
    showToast,
    statusPending,
    worktreeId
  ])
}
