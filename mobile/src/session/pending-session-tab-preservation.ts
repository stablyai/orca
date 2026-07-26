type SessionTab = {
  id: string
  isActive: boolean
}

export function preservePendingSessionTab<T extends SessionTab>(
  snapshotTabs: readonly T[],
  currentTabs: readonly T[],
  pendingTabId: string | null
): T[] {
  if (!pendingTabId || snapshotTabs.some((tab) => tab.id === pendingTabId)) {
    return [...snapshotTabs]
  }
  const pendingTab = currentTabs.find((tab) => tab.id === pendingTabId)
  if (!pendingTab) {
    return [...snapshotTabs]
  }
  return [...snapshotTabs]
    .map((tab) => (tab.isActive ? ({ ...tab, isActive: false } as T) : tab))
    .concat({ ...pendingTab, isActive: true })
}
