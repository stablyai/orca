type SessionTabLike = {
  id: string
  type: 'terminal' | 'markdown' | 'file' | 'browser'
  isActive: boolean
}

export type ResolveActiveSessionTabResult<T extends SessionTabLike> = {
  activeTab: T | null
  clearPendingActiveSessionTabId: boolean
}

export function resolveActiveSessionTab<T extends SessionTabLike>(
  tabs: readonly T[],
  opts: {
    pendingActiveSessionTabId: string | null
    currentActiveSessionTabId: string | null
  }
): ResolveActiveSessionTabResult<T> {
  const snapshotActive = tabs.find((tab) => tab.isActive) ?? tabs[0] ?? null
  const pendingActiveSessionTabId = opts.pendingActiveSessionTabId
  if (pendingActiveSessionTabId) {
    if (snapshotActive?.id === pendingActiveSessionTabId) {
      return { activeTab: snapshotActive, clearPendingActiveSessionTabId: true }
    }
    const pendingTab = tabs.find((tab) => tab.id === pendingActiveSessionTabId) ?? null
    if (pendingTab) {
      return { activeTab: pendingTab, clearPendingActiveSessionTabId: false }
    }
  }

  // Why: only browser tabs need client-side stickiness. Their snapshot `isActive`
  // flag can lag the user's current selection across refresh and navigation.
  // Terminal, markdown, and file tabs stay under snapshot authority.
  const currentActiveTab =
    tabs.find((tab) => tab.id === opts.currentActiveSessionTabId && tab.type === 'browser') ?? null
  if (currentActiveTab) {
    return { activeTab: currentActiveTab, clearPendingActiveSessionTabId: false }
  }

  return {
    activeTab: snapshotActive,
    clearPendingActiveSessionTabId: pendingActiveSessionTabId !== null
  }
}
