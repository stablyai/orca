import { useCallback } from 'react'
import {
  getTerminalRecordsFromSessionTabs,
  mergeTerminalRecordsByCurrentOrder,
  mobileSessionTabsEqual,
  terminalRecordsEqual
} from './mobile-terminal-records'
import {
  acceptSessionSnapshot,
  applyClosedTabTombstones,
  confirmsMirroredTabSelection
} from './session-tab-snapshot-gate'
import type { SessionTabsApplyOutcome } from './mobile-session-tabs-stream-health'
import { getActiveTabIdForHandle } from './mobile-session-route-helpers'
import { resolveActiveSessionTab } from './active-session-tab'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'
import type { MobileSessionTerminalListModel } from './use-mobile-session-terminal-list'

export function useMobileSessionTabApplication(scope: MobileSessionTerminalListModel) {
  const {
    setTerminals,
    terminalsRef,
    setSessionTabs,
    sessionTabsRef,
    appliedSnapshotMarkerRef,
    appliedSessionTabsRevisionRef,
    closedTabTombstonesRef,
    reconcileBufferedDraftsRef,
    setTerminalsLoaded,
    defaultTerminalHandlesToLiveInput,
    setActiveHandle,
    setActiveSessionTabId,
    activeSessionTabIdRef,
    selectedSessionTabIdRef,
    markdownDocsRef,
    initializedHandlesRef,
    terminalDiagnosticsRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    pendingActiveSessionTabIdRef,
    pendingActiveTerminalHandleRef,
    pendingBrowserFocusPageIdRef,
    initialSessionAutoCreateRef,
    unsubscribeTerminal,
    subscribeToTerminal,
    lastKnownTerminalCountRef
  } = scope
  const applySessionTabs = useCallback(
    (result: SessionTabsResult): SessionTabsApplyOutcome<MobileSessionTab> => {
      const diagnostics = terminalDiagnosticsRef.current
      // Reject stale snapshots; suppress just-closed tabs until the publisher confirms absence — see session-tab-snapshot-gate.
      if (!acceptSessionSnapshot(result, appliedSnapshotMarkerRef.current)) {
        return { accepted: false }
      }
      const applicationRevision = ++appliedSessionTabsRevisionRef.current
      let nextTabs = applyClosedTabTombstones(
        result.tabs,
        closedTabTombstonesRef.current,
        Date.now()
      )
      const presentTabIds = new Set(nextTabs.map((tab) => tab.id))
      const orphanedDraftTabs: MobileSessionTab[] = []
      const currentMarkdownDocs = markdownDocsRef.current
      const currentSessionTabs = sessionTabsRef.current
      for (const [tabId, doc] of currentMarkdownDocs) {
        if (doc.status !== 'ready' || !doc.isDirty || presentTabIds.has(tabId)) {
          continue
        }
        const draftTab = currentSessionTabs.find(
          (tab): tab is Extract<MobileSessionTab, { type: 'markdown' }> =>
            tab.type === 'markdown' && tab.id === tabId
        )
        if (draftTab) {
          // Why: mobile edits live on the phone until Save; if the desktop tab vanishes, keep drafts reachable for copy/discard.
          orphanedDraftTabs.push({ ...draftTab, isActive: tabId === activeSessionTabIdRef.current })
        }
      }
      if (orphanedDraftTabs.length > 0) {
        nextTabs = [...orphanedDraftTabs, ...nextTabs]
      }
      reconcileBufferedDraftsRef.current(currentSessionTabs, nextTabs, {
        retainMissingSurfaces: result.tabs.length === 0
      })
      sessionTabsRef.current = nextTabs
      initialSessionAutoCreateRef.current.sawSessionTabs ||= nextTabs.length > 0
      // Why: subscribe snapshots often repeat identical payloads; skip re-set to avoid a subscription teardown/replay loop.
      setSessionTabs((prev) => (mobileSessionTabsEqual(prev, nextTabs) ? prev : nextTabs))
      const terminalTabs = getTerminalRecordsFromSessionTabs(nextTabs)
      const terminalTabHandles = terminalTabs.map((terminal) => terminal.handle)
      defaultTerminalHandlesToLiveInput(terminalTabHandles)
      const mergedTerminalsForActive = mergeTerminalRecordsByCurrentOrder(
        terminalTabs,
        terminalsRef.current
      )
      terminalsRef.current = mergedTerminalsForActive
      setTerminals((prev) =>
        terminalRecordsEqual(prev, mergedTerminalsForActive) ? prev : mergedTerminalsForActive
      )
      lastKnownTerminalCountRef.current = Math.max(
        lastKnownTerminalCountRef.current,
        terminalTabs.length
      )
      setTerminalsLoaded(true)
      const outcome = {
        accepted: true as const,
        effectiveTabs: nextTabs,
        applicationRevision
      }

      const pendingActiveSessionTabId = pendingActiveSessionTabIdRef.current
      const followsHost = result.navigationIntent === 'follow'
      const pendingActiveTerminalHandle = followsHost
        ? null
        : pendingActiveTerminalHandleRef.current
      if (followsHost) {
        pendingActiveTerminalHandleRef.current = null
        pendingBrowserFocusPageIdRef.current = null
      }
      const resolved = resolveActiveSessionTab(nextTabs, {
        pendingActiveSessionTabId,
        selectedSessionTabId: selectedSessionTabIdRef.current,
        navigationIntent: result.navigationIntent
      })
      let active = resolved.activeTab
      let selectionSource: string = resolved.selectionSource
      if (resolved.clearPendingActiveSessionTabId) {
        const localAck =
          !followsHost &&
          nextTabs.find((tab) => tab.isActive)?.id === pendingActiveSessionTabId &&
          !confirmsMirroredTabSelection(result.publicationEpoch)
        selectionSource = localAck ? 'pending-tab-local-ack' : selectionSource
        pendingActiveSessionTabIdRef.current = localAck ? pendingActiveSessionTabId : null
      }
      if (pendingActiveTerminalHandle) {
        const pendingTerminalTab = nextTabs.find(
          (tab): tab is Extract<MobileSessionTab, { type: 'terminal' }> =>
            tab.type === 'terminal' && tab.terminal === pendingActiveTerminalHandle
        )
        const pendingTerminalExists = mergedTerminalsForActive.some(
          (terminal) => terminal.handle === pendingActiveTerminalHandle
        )
        if (active?.type === 'terminal' && active.terminal === pendingActiveTerminalHandle) {
          const snapshotActive = nextTabs.find((tab) => tab.isActive) ?? nextTabs[0] ?? null
          if (
            snapshotActive?.type === 'terminal' &&
            snapshotActive.terminal === pendingActiveTerminalHandle &&
            !confirmsMirroredTabSelection(result.publicationEpoch)
          ) {
            selectionSource = 'pending-handle-local-ack'
          } else {
            pendingActiveTerminalHandleRef.current = null
          }
        } else if (pendingTerminalTab) {
          // Why: desktop active flags lag a mobile tap; key by handle too, as fallback PTY tabs lack a stable tab id at startup.
          active = pendingTerminalTab
          selectionSource = 'pending-handle-tab'
        } else if (pendingTerminalExists) {
          const nextActiveTabId = getActiveTabIdForHandle(nextTabs, pendingActiveTerminalHandle)
          activeSessionTabIdRef.current = nextActiveTabId
          setActiveSessionTabId(nextActiveTabId)
          activeSessionTabTypeRef.current = 'terminal'
          // Why: every other active-handle branch assigns the ref alongside the
          // state. Leaving it stale here makes `covered` resolve against the wrong
          // handle, so a native-chat rearm silently no-ops on the webview gates.
          activeHandleRef.current = pendingActiveTerminalHandle
          setActiveHandle(pendingActiveTerminalHandle)
          subscribeToTerminal(pendingActiveTerminalHandle)
          return outcome
        } else {
          pendingActiveTerminalHandleRef.current = null
        }
      }
      diagnostics.tabsApplied(result, nextTabs, active, selectionSource)
      if (!resolved.retainSelectedSessionTabId || active !== resolved.activeTab) {
        selectedSessionTabIdRef.current = active?.id ?? null
      }
      activeSessionTabTypeRef.current = active?.type ?? null
      activeSessionTabIdRef.current = active?.id ?? null
      setActiveSessionTabId(active?.id ?? null)
      if (active?.type === 'terminal') {
        if (typeof active.terminal !== 'string') {
          const previous = activeHandleRef.current
          if (previous) {
            unsubscribeTerminal(previous)
            initializedHandlesRef.current.delete(previous)
          }
          activeHandleRef.current = null
          setActiveHandle(null)
          return outcome
        }
        const previous = activeHandleRef.current
        if (previous && previous !== active.terminal) {
          unsubscribeTerminal(previous)
          initializedHandlesRef.current.delete(previous)
        }
        activeHandleRef.current = active.terminal
        setActiveHandle(active.terminal)
        subscribeToTerminal(active.terminal)
      } else if (active) {
        // Why: an empty snapshot can transiently omit a live terminal; explicit close clears it on RPC success.
        const previous = activeHandleRef.current
        if (previous) {
          unsubscribeTerminal(previous)
          initializedHandlesRef.current.delete(previous)
        }
        activeHandleRef.current = null
        setActiveHandle(null)
      }
      return outcome
    },
    [defaultTerminalHandlesToLiveInput, subscribeToTerminal, unsubscribeTerminal]
  )
  return {
    applySessionTabs
  }
}

export type MobileSessionTabApplicationModel = MobileSessionTerminalListModel &
  ReturnType<typeof useMobileSessionTabApplication>
