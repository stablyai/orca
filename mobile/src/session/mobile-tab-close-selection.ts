type BulkClosableTab = {
  id: string
  isDirty?: boolean
  isPinned?: boolean
}

/**
 * Pick the other tabs a long-press bulk close should target, in strip order.
 * Dirty documents are skipped — mobile has no save prompt on close, so bulk
 * closing must never silently discard unsaved edits.
 */
export function selectBulkCloseTabs<T extends BulkClosableTab>(
  tabs: readonly T[],
  anchorTabId: string
): T[] {
  const anchorIndex = tabs.findIndex((tab) => tab.id === anchorTabId)
  if (anchorIndex === -1) {
    return []
  }
  const candidates = tabs.filter((_, index) => index !== anchorIndex)
  return candidates.filter((tab) => tab.isDirty !== true && tab.isPinned !== true)
}
