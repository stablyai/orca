import { expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'

import { OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs } from './session-lifecycle/projection/reconcile-headless-mobile-session-browser-tabs'

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

function isHeadlessBuiltPublication(publicationEpoch: string): boolean {
  const base = publicationEpoch.split(':headless-merge:')[0]
  return base.startsWith('headless:') || base.startsWith('headless-hydrated:')
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test invokes protected reconciliation method on class prototype.
  const proto = OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs.prototype as unknown as {
    reconcileHeadlessMobileSessionBrowserTabs(
      worktreeId: string,
      existing: RuntimeMobileSessionTabsSnapshot
    ): void
    reconcileOffscreenOwnedMobileSessionBrowserTabs(
      worktreeId: string,
      existing: RuntimeMobileSessionTabsSnapshot,
      existingBrowserTabs: RuntimeMobileSessionBrowserTab[]
    ): void
  }
  proto.reconcileHeadlessMobileSessionBrowserTabs.call(
    {
      buildHeadlessMobileSessionBrowserTabs: () => host.live ?? [],
      getAvailableAuthoritativeWindow: () => (host.attached === false ? null : {}),
      offscreenBrowserBackend: host.offscreen === true ? {} : null,
      storeMobileSessionSnapshot,
      reconcileOffscreenOwnedMobileSessionBrowserTabs:
        proto.reconcileOffscreenOwnedMobileSessionBrowserTabs,
      isHeadlessBuiltMobileSessionPublicationBase: isHeadlessBuiltPublication,
      getAcceptedRendererIdentityKeysForMobileSessionSnapshot() {
        return null
      },
      isRendererOwnedMobileBrowserTab(
        snapshot: RuntimeMobileSessionTabsSnapshot,
        tab: RuntimeMobileSessionBrowserTab
      ) {
        return (
          tab.placement?.kind !== 'client' && !isHeadlessBuiltPublication(snapshot.publicationEpoch)
        )
      }
    },
    'wt',
    existing
  )
  return storeMobileSessionSnapshot.mock.calls[0]?.[1]
}

it.each([false, true])('retires absent offscreen pages when attached=%s', (attached) => {
  expect(
    reconcile({ attached, offscreen: true }, { ...snapshot, publicationEpoch: 'headless:1' })?.tabs
  ).toEqual([])
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
