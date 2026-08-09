// Pure resolver for the phone's active session tab. Kept free of react-native
// imports so it stays unit-testable in the node test env.

type SessionTabLike = {
  id: string
  type: 'terminal' | 'markdown' | 'file' | 'browser'
  isActive: boolean
}

export type ActiveSessionTabSelectionSource =
  | 'snapshot'
  | 'pending-tab'
  | 'selected-tab'
  | 'navigation-intent'

export type ResolveActiveSessionTabResult<T extends SessionTabLike> = {
  activeTab: T | null
  selectionSource: ActiveSessionTabSelectionSource
  clearPendingActiveSessionTabId: boolean
  /** The device's pick vanished for this snapshot only; keep it so the tab re-binds when it returns. */
  retainSelectedSessionTabId: boolean
}

/**
 * Decides which tab the phone shows for an accepted snapshot. The phone owns its
 * own view: an ordinary state republication (agent turn, desktop focus change,
 * browser command bootstrap) must not move the user off the tab they are on.
 */
export function resolveActiveSessionTab<T extends SessionTabLike>(
  tabs: readonly T[],
  opts: {
    pendingActiveSessionTabId: string | null
    selectedSessionTabId: string | null
    navigationIntent?: 'follow'
  }
): ResolveActiveSessionTabResult<T> {
  const snapshotActive = tabs.find((tab) => tab.isActive) ?? tabs[0] ?? null
  const pendingActiveSessionTabId = opts.pendingActiveSessionTabId
  if (pendingActiveSessionTabId) {
    if (snapshotActive?.id === pendingActiveSessionTabId) {
      return {
        activeTab: snapshotActive,
        selectionSource: 'snapshot',
        clearPendingActiveSessionTabId: true,
        retainSelectedSessionTabId: false
      }
    }
    // Why: snapshots lag a mobile tap while the activate RPC is in flight; keep the local pick.
    const pendingTab = tabs.find((tab) => tab.id === pendingActiveSessionTabId) ?? null
    if (pendingTab) {
      return {
        activeTab: pendingTab,
        selectionSource: 'pending-tab',
        clearPendingActiveSessionTabId: false,
        retainSelectedSessionTabId: false
      }
    }
  }
  const clearPendingActiveSessionTabId = pendingActiveSessionTabId !== null
  // Why: 'follow' is the host explicitly navigating this device (desktop/CLI `navigation: clients|all`).
  if (opts.navigationIntent === 'follow') {
    return {
      activeTab: snapshotActive,
      selectionSource: 'navigation-intent',
      clearPendingActiveSessionTabId,
      retainSelectedSessionTabId: false
    }
  }
  if (opts.selectedSessionTabId) {
    const selectedTab = tabs.find((tab) => tab.id === opts.selectedSessionTabId) ?? null
    if (selectedTab) {
      return {
        activeTab: selectedTab,
        selectionSource: 'selected-tab',
        clearPendingActiveSessionTabId,
        retainSelectedSessionTabId: false
      }
    }
    // Why: a browser guest process swap drops its tab from one snapshot; show the
    // fallback but remember the pick so the tab reclaims focus when it reappears.
    return {
      activeTab: snapshotActive,
      selectionSource: 'snapshot',
      clearPendingActiveSessionTabId,
      retainSelectedSessionTabId: true
    }
  }
  return {
    activeTab: snapshotActive,
    selectionSource: 'snapshot',
    clearPendingActiveSessionTabId,
    retainSelectedSessionTabId: false
  }
}
