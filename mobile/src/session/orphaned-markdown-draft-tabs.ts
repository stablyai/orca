import type { MarkdownDocState, MobileSessionTab } from './mobile-session-route-types'

// Keep phone-local document drafts reachable after desktop tab removal so users can copy/discard them.
export function orphanedMarkdownDraftTabs(
  nextTabs: readonly MobileSessionTab[],
  currentTabs: readonly MobileSessionTab[],
  markdownDocs: ReadonlyMap<string, MarkdownDocState>,
  activeTabId: string | null
): MobileSessionTab[] {
  const presentTabIds = new Set(nextTabs.map((tab) => tab.id))
  const orphaned: MobileSessionTab[] = []
  for (const [tabId, doc] of markdownDocs) {
    if (doc.status !== 'ready' || !doc.isDirty || presentTabIds.has(tabId)) {
      continue
    }
    const draftTab = currentTabs.find(
      (tab): tab is Extract<MobileSessionTab, { type: 'markdown' }> =>
        tab.type === 'markdown' && tab.id === tabId
    )
    if (draftTab) {
      orphaned.push({ ...draftTab, isActive: tabId === activeTabId })
    }
  }
  return orphaned
}
