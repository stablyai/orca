import '../../orca-runtime-tests/orca-runtime-test-lifecycle.spec'
import { expect, it, vi } from 'vitest'

import '../../orca-runtime-tests/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'

import { electronMocks } from '../../orca-runtime-test-mocks/setup.spec'

import { TEST_WORKTREE_ID, store } from '../../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import '../../../../shared/orca-profiles/constants'

import type { BrowserTabInfo } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import type { RuntimeMobileSessionBrowserTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const rendererTab: RuntimeMobileSessionBrowserTab = {
  type: 'browser',
  id: 'renderer-tab',
  browserWorkspaceId: 'renderer-workspace',
  browserPageId: 'renderer-page',
  title: 'Unmounted renderer page',
  url: 'https://renderer.example/',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true
}

function publication(epoch = 'renderer-1', version = 1): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: epoch,
    snapshotVersion: version,
    activeGroupId: 'renderer-group',
    activeTabId: rendererTab.id,
    activeTabType: 'browser',
    tabs: [rendererTab],
    tabGroups: [{ id: 'renderer-group', activeTabId: rendererTab.id, tabOrder: [rendererTab.id] }]
  }
}

function browserRuntime(closeTab = vi.fn(async (_pageId: string) => {}), runtimeStore = store) {
  const livePages = new Map<string, BrowserTabInfo>()
  const desktopPageIds = new Set<string>()
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setOffscreenBrowserBackend({
    createTab: vi.fn(),
    closeTab,
    ownsTab: (pageId) => livePages.has(pageId) && !desktopPageIds.has(pageId)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the bridge inventory is used by this lifecycle test.
  runtime.setAgentBrowserBridge({
    tabList: () => ({ tabs: [...livePages.values()] }),
    getRemoteTabFaviconUrl: () => null,
    getPageNavigationState: () => null
  } as never)
  electronMocks.BrowserWindow.fromId.mockImplementation((id: number) =>
    id === 1 ? { isDestroyed: () => false } : null
  )
  runtime.attachWindow(1)
  const sync = async (snapshots: RuntimeMobileSessionTabsSnapshot[]) =>
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: snapshots })
  // Desktop webviews share the bridge inventory with offscreen pages but the backend does not own them.
  const addDesktopPage = (browserPageId: string) => {
    desktopPageIds.add(browserPageId)
    addPage(browserPageId)
  }
  const addPage = (browserPageId: string) =>
    livePages.set(browserPageId, {
      browserPageId,
      index: livePages.size,
      title: browserPageId,
      url: `https://${browserPageId}.example/`,
      active: false
    })
  const list = () => runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  return { runtime, livePages, sync, addPage, addDesktopPage, list }
}

it('keeps a replacement client page through a stale placement retirement and retires only the live generation', async () => {
  const { runtime, sync, list } = browserRuntime()
  await sync([publication()])
  const pages = getRuntimeBrowserPageRegistry(runtime)
  const original = {
    kind: 'client' as const,
    browserHostClientId: 'phone',
    browserHostGeneration: 1,
    pageHostGeneration: 1
  }
  const replacement = { ...original, browserHostGeneration: 2, pageHostGeneration: 2 }
  const page = {
    browserPageId: 'reconnected-client-page',
    workspaceId: TEST_WORKTREE_ID,
    browserProfileId: 'profile',
    executionHostKey: 'host',
    url: 'https://client.example/',
    loading: false,
    active: false
  }
  pages.publishClientPage({ ...page, placement: original })
  runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)
  expect(pages.retirePage(page.browserPageId, original)).toBe(true)
  pages.publishClientPage({ ...page, placement: replacement, title: 'Reconnected page' })
  expect(pages.retirePage(page.browserPageId, original)).toBe(false)
  runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)
  const reconnected = await list()
  expect(reconnected.tabs.map((tab) => tab.id)).toEqual(['renderer-tab', page.browserPageId])
  expect(reconnected.tabs[1]).toMatchObject({ title: 'Reconnected page', placement: replacement })
  expect(reconnected.publicationEpoch).toBe('renderer-1')

  expect(pages.retirePage(page.browserPageId, replacement)).toBe(true)
  runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)
  const retired = await list()
  expect(retired.tabs.map((tab) => tab.id)).toEqual(['renderer-tab'])
  expect(retired.tabGroups?.flatMap((group) => group.tabOrder)).toEqual(['renderer-tab'])
})
