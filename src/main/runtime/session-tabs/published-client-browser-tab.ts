import type { RuntimeBrowserClientPage } from '../runtime-browser-page-registry'
import type { RuntimeMobileSessionBrowserTab } from '../../../shared/runtime-types'

export function publishedClientBrowserTab(
  page: RuntimeBrowserClientPage
): RuntimeMobileSessionBrowserTab {
  return {
    type: 'browser' as const,
    id: page.browserPageId,
    title: page.title || page.url || 'Browser',
    browserWorkspaceId: page.browserPageId,
    browserPageId: page.browserPageId,
    browserProfileId: page.browserProfileId,
    executionHostKey: page.executionHostKey,
    placement: page.placement,
    url: page.url,
    loading: page.loading,
    canGoBack: page.canGoBack,
    canGoForward: page.canGoForward,
    isActive: page.active
  }
}
