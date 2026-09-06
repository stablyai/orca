import { expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { OrcaRuntimeWithCloseStructuredAgentSessionTab } from './orca-runtime-close-structured-agent-session-tab'
import { OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs } from './orca-runtime-reconcile-headless-mobile-session-browser-tabs'

const rendererPage: RuntimeMobileSessionBrowserTab = {
  type: 'browser',
  id: 'renderer-tab',
  browserWorkspaceId: 'renderer-workspace',
  browserPageId: 'renderer-page',
  title: 'Server page',
  url: 'https://example.com/server',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: false
}
const snapshot: RuntimeMobileSessionTabsSnapshot = {
  worktree: 'wt',
  publicationEpoch: 'renderer:1',
  snapshotVersion: 1,
  activeGroupId: 'group',
  activeTabId: 'renderer-tab',
  activeTabType: 'browser',
  tabs: [rendererPage],
  tabGroups: [{ id: 'group', activeTabId: 'renderer-tab', tabOrder: ['renderer-tab'] }]
}

it('keeps renderer-owned browser pages when refreshing client-hosted pages on an attached desktop', () => {
  const storeMobileSessionSnapshot = vi.fn()
  const reconcile =
    OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs.prototype as unknown as {
      reconcileHeadlessMobileSessionBrowserTabs(
        worktreeId: string,
        snapshot: RuntimeMobileSessionTabsSnapshot
      ): void
    }
  reconcile.reconcileHeadlessMobileSessionBrowserTabs.call(
    {
      buildHeadlessMobileSessionBrowserTabs: () => [],
      getAvailableAuthoritativeWindow: () => ({}),
      offscreenBrowserBackend: null,
      storeMobileSessionSnapshot
    },
    'wt',
    snapshot
  )
  const published = storeMobileSessionSnapshot.mock.calls[0]?.[1] ?? snapshot
  expect(published.tabs).toContainEqual(rendererPage)
  expect(published.tabGroups[0].tabOrder).toContain('renderer-tab')
})

it.each([false, true])('retires absent offscreen pages when attached=%s', (attached) => {
  const storeMobileSessionSnapshot = vi.fn()
  const reconcile =
    OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs.prototype as unknown as {
      reconcileHeadlessMobileSessionBrowserTabs(
        worktreeId: string,
        snapshot: RuntimeMobileSessionTabsSnapshot
      ): void
    }
  reconcile.reconcileHeadlessMobileSessionBrowserTabs.call(
    {
      buildHeadlessMobileSessionBrowserTabs: () => [],
      getAvailableAuthoritativeWindow: () => (attached ? {} : null),
      offscreenBrowserBackend: {},
      storeMobileSessionSnapshot
    },
    'wt',
    snapshot
  )
  expect(storeMobileSessionSnapshot.mock.calls[0]?.[1].tabs).toEqual([])
})

it('removes retired client pages and publishes live ones while retaining renderer rows and group order', () => {
  const clientPage: RuntimeMobileSessionBrowserTab = {
    ...rendererPage,
    id: 'client',
    browserWorkspaceId: 'client',
    browserPageId: 'client',
    placement: {
      kind: 'client',
      browserHostClientId: 'host',
      browserHostGeneration: 1,
      pageHostGeneration: 1
    }
  }
  const livePage = { ...clientPage, id: 'live', browserWorkspaceId: 'live', browserPageId: 'live' }
  const storeMobileSessionSnapshot = vi.fn()
  const reconcile =
    OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs.prototype as unknown as {
      reconcileHeadlessMobileSessionBrowserTabs(
        worktreeId: string,
        snapshot: RuntimeMobileSessionTabsSnapshot
      ): void
    }
  reconcile.reconcileHeadlessMobileSessionBrowserTabs.call(
    {
      buildHeadlessMobileSessionBrowserTabs: () => [livePage],
      getAvailableAuthoritativeWindow: () => ({}),
      offscreenBrowserBackend: null,
      storeMobileSessionSnapshot
    },
    'wt',
    {
      ...snapshot,
      tabs: [rendererPage, clientPage],
      tabGroups: [
        { id: 'group', activeTabId: 'renderer-tab', tabOrder: ['renderer-tab', 'client'] }
      ]
    }
  )
  const published = storeMobileSessionSnapshot.mock.calls[0]?.[1]
  expect(published.tabs).toEqual([rendererPage, livePage])
  expect(published.tabGroups[0].tabOrder).toEqual(['renderer-tab', 'live'])
  expect(published.activeTabId).toBe('renderer-tab')
  expect(published.publicationEpoch).toBe(snapshot.publicationEpoch)
  expect(published.snapshotVersion).toBe(snapshot.snapshotVersion + 1)
})

it('keeps the renderer publication epoch when selecting a client-hosted browser tab', () => {
  const storeMobileSessionSnapshot = vi.fn()
  const runtime = OrcaRuntimeWithCloseStructuredAgentSessionTab.prototype as unknown as {
    markHeadlessBrowserSessionTabActive(
      worktreeId: string,
      browserPageId: string,
      options: { focusesHost: boolean }
    ): void
  }
  runtime.markHeadlessBrowserSessionTabActive.call(
    {
      offscreenBrowserBackend: {},
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: () => undefined,
      mobileSessionTabsByWorktree: new Map([['wt', snapshot]]),
      storeMobileSessionSnapshot,
      emitMobileSessionTabsSnapshot: vi.fn()
    },
    'wt',
    'renderer-page',
    { focusesHost: false }
  )
  expect(storeMobileSessionSnapshot.mock.calls[0]?.[1].publicationEpoch).toBe(
    snapshot.publicationEpoch
  )
})
