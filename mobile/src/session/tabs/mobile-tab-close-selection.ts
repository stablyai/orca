type BulkClosableTab = {
  id: string
  isDirty?: boolean
  isPinned?: boolean
}

// Skip dirty documents during bulk close because mobile has no save prompt to protect unsaved edits.
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
