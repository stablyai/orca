import type { RuntimeMobileSessionBrowserTab } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import type {
  BrowserCertificateFailure,
  BrowserLoadError
} from '../../../../shared/browser-workspace-types'
import type { RuntimeBrowserClientPage } from '../../runtime-browser-page-registry'

export type HeadlessServerBrowserTabSource = {
  browserPageId: string
  title?: string | null
  url?: string | null
  loadError?: BrowserLoadError | null
  certificateFailure?: BrowserCertificateFailure | null
  active?: boolean
}

export function projectHeadlessServerBrowserTab(
  tab: HeadlessServerBrowserTabSource,
  persistedProps: Pick<Tab, 'color' | 'isPinned'> | null
): RuntimeMobileSessionBrowserTab {
  return {
    type: 'browser' as const,
    id: tab.browserPageId,
    title: tab.title || tab.url || 'Browser',
    browserWorkspaceId: tab.browserPageId,
    browserPageId: tab.browserPageId,
    url: tab.url || 'about:blank',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    loadError: tab.loadError ?? undefined,
    certificateFailure: tab.certificateFailure ?? undefined,
    ...(persistedProps ? { color: persistedProps.color } : {}),
    ...(persistedProps ? { isPinned: persistedProps.isPinned === true } : {}),
    isActive: tab.active === true
  }
}

export function projectHeadlessClientBrowserTab(
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
