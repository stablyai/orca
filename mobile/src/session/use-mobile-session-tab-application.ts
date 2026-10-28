import {
  pendingSelectionHandle,
  pendingSelectionTabId,
  resolveLaunchedSelection,
  withoutPendingHandle,
  withoutPendingTabId
} from './pending-session-selection'
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
import { activateMobileSessionTab } from './mobile-session-tab-activation'
import { releaseTerminalCreateLock } from './terminal-create-lock'
import { withSessionTabStatusReceipts } from './mobile-session-tab-status-clock'
import { withRememberedNativeChatIdentity } from './native-chat/mobile-native-chat-eligibility'
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
    terminalDiagnosticsRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    pendingSelectionRef,
    pendingBrowserFocusPageIdRef,
    initialSessionAutoCreateRef,
    unsubscribeTerminal,
    subscribeToTerminal,
    lastKnownTerminalCountRef,
    clientRef,
    creatingTerminalRef,
    setCreating
  } = scope
  const applySessionTabs = useCallback(
    (result: SessionTabsResult): SessionTabsApplyOutcome<MobileSessionTab> => {
      const diagnostics = terminalDiagnosticsRef.current
      if (!acceptSessionSnapshot(result, appliedSnapshotMarkerRef.current)) {
        return { accepted: false }
      }
      const applicationRevision = ++appliedSessionTabsRevisionRef.current
      const now = Date.now()
      let nextTabs = withRememberedNativeChatIdentity(
        withSessionTabStatusReceipts(
          applyClosedTabTombstones(result.tabs, closedTabTombstonesRef.current, now),
          sessionTabsRef.current,
          now
        ),
        sessionTabsRef.current
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
          // Keep phone-local document drafts reachable after desktop tab removal so users can copy/discard them.
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
      // Avoid identical snapshot state updates that would tear down and replay subscriptions.
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

      const followsHost = result.navigationIntent === 'follow'
      if (followsHost) {
        pendingSelectionRef.current = withoutPendingHandle(
          pendingSelectionRef.current?.kind === 'launched' ? null : pendingSelectionRef.current
        )
        pendingBrowserFocusPageIdRef.current = null
      } else {
        const pending = pendingSelectionRef.current
        const launch = resolveLaunchedSelection(pending, nextTabs)
        pendingSelectionRef.current = launch.selection
        if (launch.landedTabId && pending?.kind === 'launched') {
          // Release creation when its tab lands; prompt delivery can delay the reply by a minute.
          releaseTerminalCreateLock({ creatingTerminalRef, setCreating }, pending.lock)
        }
        if (launch.landedTabId && clientRef.current) {
          // Launches carry no navigation; persist the pick or this device stays on its old host tab.
          void activateMobileSessionTab(clientRef.current, {
            worktree: `id:${result.worktree}`,
            tabId: launch.landedTabId,
            notifyClients: false,
            navigation: 'caller',
            intent: 'user'
          }).catch(() => {})
        }
      }
      const pendingActiveSessionTabId = pendingSelectionTabId(pendingSelectionRef.current)
      const pendingActiveTerminalHandle = pendingSelectionHandle(pendingSelectionRef.current)
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
        if (!localAck) {
          pendingSelectionRef.current = withoutPendingTabId(pendingSelectionRef.current)
        }
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
            pendingSelectionRef.current = withoutPendingHandle(pendingSelectionRef.current)
          }
        } else if (pendingTerminalTab) {
          // Use handle fallback because host active flags lag taps and startup PTY tabs may lack stable ids.
          active = pendingTerminalTab
          selectionSource = 'pending-handle-tab'
        } else if (pendingTerminalExists) {
          const nextActiveTabId = getActiveTabIdForHandle(nextTabs, pendingActiveTerminalHandle)
          activeSessionTabIdRef.current = nextActiveTabId
          setActiveSessionTabId(nextActiveTabId)
          activeSessionTabTypeRef.current = 'terminal'
          // Update the active-handle ref with state so chat coverage/rearm cannot read the wrong WebView gate.
          activeHandleRef.current = pendingActiveTerminalHandle
          setActiveHandle(pendingActiveTerminalHandle)
          subscribeToTerminal(pendingActiveTerminalHandle)
          return outcome
        } else {
          pendingSelectionRef.current = withoutPendingHandle(pendingSelectionRef.current)
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
          }
          activeHandleRef.current = null
          setActiveHandle(null)
          return outcome
        }
        const previous = activeHandleRef.current
        if (previous && previous !== active.terminal) {
          unsubscribeTerminal(previous)
        }
        activeHandleRef.current = active.terminal
        setActiveHandle(active.terminal)
        subscribeToTerminal(active.terminal)
      } else if (active) {
        // Transient empty snapshots may omit a live terminal; only explicit successful close clears it.
        const previous = activeHandleRef.current
        if (previous) {
          unsubscribeTerminal(previous)
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
