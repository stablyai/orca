type SessionTabId = {
  id: string
}

const MOBILE_SESSION_TAB_RECENCY_LIMIT = 100

export function recordMobileSessionTabActivation(
  recentTabIds: readonly string[],
  tabs: readonly SessionTabId[],
  activeTabId: string | null
): string[] {
  const validIds = new Set(tabs.map((tab) => tab.id))
  const seen = new Set<string>()
  const recent = recentTabIds.toReversed().filter((id) => {
    if (id === activeTabId || seen.has(id)) {
      return false
    }
    seen.add(id)
    return true
  })
  recent.reverse()
  if (activeTabId && validIds.has(activeTabId)) {
    recent.push(activeTabId)
  }
  // Browser guest swaps can briefly omit a tab, so keep absent IDs within a fixed history bound.
  return recent.slice(-MOBILE_SESSION_TAB_RECENCY_LIMIT)
}

export function pickMobileSessionTabAfterClose<T extends SessionTabId>(
  tabsAtCloseStart: readonly T[],
  survivingTabs: readonly T[],
  recentTabIds: readonly string[],
  closingTabId: string
): T | null {
  const survivingById = new Map(
    survivingTabs.filter((tab) => tab.id !== closingTabId).map((tab) => [tab.id, tab])
  )
  for (let index = recentTabIds.length - 1; index >= 0; index -= 1) {
    const recent = survivingById.get(recentTabIds[index])
    if (recent) {
      return recent
    }
  }

  const closingIndex = tabsAtCloseStart.findIndex((tab) => tab.id === closingTabId)
  if (closingIndex === -1) {
    return null
  }
  return (
    survivingById.get(tabsAtCloseStart[closingIndex + 1]?.id) ??
    survivingById.get(tabsAtCloseStart[closingIndex - 1]?.id) ??
    null
  )
}

export function shouldRestoreMobileSessionTabAfterClose(args: {
  closingTabId: string
  activeTabIdAtCloseStart: string | null
  selectionRevisionAtCloseStart: number
  currentSelectionRevision: number
}): boolean {
  return (
    args.activeTabIdAtCloseStart === args.closingTabId &&
    args.selectionRevisionAtCloseStart === args.currentSelectionRevision
  )
}
