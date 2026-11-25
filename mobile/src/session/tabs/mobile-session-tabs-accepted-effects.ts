import type { SessionTabsStreamSource } from './mobile-session-tabs-stream-health'

type AcceptedSessionTab = {
  id: string
  type: string
  isActive: boolean
  browserPageId?: string | null
  isDirty?: boolean
}

type Options<Tab extends AcceptedSessionTab> = {
  effectiveTabs: readonly Tab[]
  source: SessionTabsStreamSource
  getPendingBrowserPageId: () => string | null
  clearPendingBrowserPageId: (pageId: string) => void
  activateBrowserTab: (tab: Tab) => void
  markActiveMarkdownStale: (tabId: string) => void
}

export function runAcceptedMobileSessionTabsEffects<Tab extends AcceptedSessionTab>({
  effectiveTabs,
  source,
  getPendingBrowserPageId,
  clearPendingBrowserPageId,
  activateBrowserTab,
  markActiveMarkdownStale
}: Options<Tab>): void {
  const pendingPageId = getPendingBrowserPageId()
  if (pendingPageId) {
    const browserTab = effectiveTabs.find(
      (tab) => tab.type === 'browser' && tab.browserPageId === pendingPageId
    )
    if (browserTab) {
      clearPendingBrowserPageId(pendingPageId)
      activateBrowserTab(browserTab)
    }
  }
  if (source !== 'stream') {
    return
  }
  const activeMarkdown = effectiveTabs.find(
    (tab) => tab.type === 'markdown' && tab.isActive && tab.isDirty
  )
  if (activeMarkdown) {
    markActiveMarkdownStale(activeMarkdown.id)
  }
}
