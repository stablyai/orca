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

/** Drives the reconcile against a stub host and returns the published snapshot, if any. */
function reconcile(
  host: {
    live?: RuntimeMobileSessionBrowserTab[]
    attached?: boolean
    offscreen?: boolean
  },
  existing: RuntimeMobileSessionTabsSnapshot = snapshot
): RuntimeMobileSessionTabsSnapshot | undefined {
  const storeMobileSessionSnapshot = vi.fn()
  const runtime = OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs.prototype as unknown as {
    reconcileHeadlessMobileSessionBrowserTabs(
      worktreeId: string,
      existing: RuntimeMobileSessionTabsSnapshot
    ): void
  }
  runtime.reconcileHeadlessMobileSessionBrowserTabs.call(
    {
      buildHeadlessMobileSessionBrowserTabs: () => host.live ?? [],
      getAvailableAuthoritativeWindow: () => (host.attached === false ? null : {}),
      offscreenBrowserBackend: host.offscreen === true ? {} : null,
      storeMobileSessionSnapshot
    },
    'wt',
    existing
  )
  return storeMobileSessionSnapshot.mock.calls[0]?.[1]
}

it('keeps renderer-owned browser pages when refreshing client-hosted pages on an attached desktop', () => {
  const published = reconcile({}) ?? snapshot

  expect(published.tabs).toContainEqual(rendererPage)
  expect(published.tabGroups?.[0].tabOrder).toContain('renderer-tab')
})

it.each([false, true])('retires absent offscreen pages when attached=%s', (attached) => {
  expect(reconcile({ attached, offscreen: true })?.tabs).toEqual([])
})

it('removes retired client pages and publishes live ones while retaining renderer rows and group order', () => {
  const livePage = { ...clientPage, id: 'live', browserWorkspaceId: 'live', browserPageId: 'live' }

  const published = reconcile(
    { live: [livePage] },
    {
      ...snapshot,
      tabs: [rendererPage, clientPage],
      tabGroups: [
        { id: 'group', activeTabId: 'renderer-tab', tabOrder: ['renderer-tab', 'client'] }
      ]
    }
  )

  expect(published?.tabs).toEqual([rendererPage, livePage])
  expect(published?.tabGroups?.[0].tabOrder).toEqual(['renderer-tab', 'live'])
  expect(published?.activeTabId).toBe('renderer-tab')
  expect(published?.publicationEpoch).toBe(snapshot.publicationEpoch)
  expect(published?.snapshotVersion).toBe(snapshot.snapshotVersion + 1)
})

it('never publishes a row twice when the live build reclaims a renderer-owned id', () => {
  const reclaimed = {
    ...clientPage,
    id: rendererPage.id,
    browserPageId: rendererPage.browserPageId
  }

  const published = reconcile({ live: [reclaimed] })

  expect(published?.tabs).toEqual([reclaimed])
  expect(published?.tabGroups?.[0].tabOrder).toEqual([rendererPage.id])
})

it('does not republish when a client row merely sits before a renderer row', () => {
  const interleaved = {
    ...snapshot,
    tabs: [clientPage, rendererPage],
    tabGroups: [{ id: 'group', activeTabId: 'renderer-tab', tabOrder: ['client', 'renderer-tab'] }]
  }

  expect(reconcile({ live: [clientPage] }, interleaved)).toBeUndefined()
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
