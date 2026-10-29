import './orca-runtime-test-lifecycle.spec'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService, electronMocks } from './orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  store
} from './orca-runtime-test-fixtures.spec'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type {
  BrowserTabInfo,
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
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
  runtime.setAgentBrowserBridge({ tabList: () => ({ tabs: [...livePages.values()] }) } as never)
  electronMocks.BrowserWindow.fromId.mockImplementation((id: number) =>
    id === 1 ? { isDestroyed: () => false } : null
  )
  runtime.attachWindow(1)
  const sync = (snapshots: RuntimeMobileSessionTabsSnapshot[]) =>
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: snapshots })
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

it('finishes an offscreen close against the latest renderer revision without losing newer tabs', async () => {
  const closing = Promise.withResolvers<void>()
  const closeTab = vi.fn(async (_pageId: string) => closing.promise)
  const { runtime, livePages, sync, addPage, list } = browserRuntime(closeTab)
  sync([publication()])
  addPage('runtime-page')
  runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)
  expect((await list()).tabs.map((tab) => tab.id)).toEqual(['renderer-tab', 'runtime-page'])
  const close = runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'runtime-page', {
    expectedPublicationEpoch: 'renderer-1'
  })
  await vi.waitFor(() => expect(closeTab).toHaveBeenCalledWith('runtime-page'))

  const newerTab = {
    ...rendererTab,
    id: 'renderer-new',
    browserWorkspaceId: 'renderer-new-workspace',
    browserPageId: 'renderer-new-page',
    isActive: false
  }
  sync([{ ...publication('renderer-2'), tabs: [rendererTab, newerTab] }])
  livePages.delete('runtime-page')
  closing.resolve()
  await expect(close).resolves.toMatchObject({ closed: true })
  const afterClose = await list()
  expect(afterClose.publicationEpoch).toBe('renderer-2')
  expect(afterClose.tabs.map((tab) => tab.id)).toEqual(['renderer-tab', 'renderer-new'])

  await expect(
    runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, rendererTab.id, {
      expectedPublicationEpoch: 'renderer-1'
    })
  ).resolves.toMatchObject({ refused: true, refusalReason: 'stale-publication' })
  expect(closeTab).toHaveBeenCalledTimes(1)
  expect((await list()).tabs.map((tab) => tab.id)).toEqual(['renderer-tab', 'renderer-new'])

  sync([publication('renderer-2', 2)])
  expect((await list()).tabs.map((tab) => tab.id)).toEqual(['renderer-tab'])
  sync([{ ...publication('renderer-2', 1), tabs: [rendererTab, newerTab] }])
  expect((await list()).tabs.map((tab) => tab.id)).toEqual(['renderer-tab'])
})

it('rebases omitted renderer publications and accepts their return without reviving dead pages', async () => {
  const { runtime, livePages, sync, addPage, list } = browserRuntime()
  sync([publication()])
  addPage('runtime-live')
  addPage('runtime-dead')
  runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)
  expect((await list()).tabs).toHaveLength(3)
  livePages.delete('runtime-dead')

  sync([])
  const detached = await list()
  expect(detached.publicationEpoch).toMatch(/^headless-hydrated:/)
  expect(detached.tabs.map((tab) => tab.id)).toEqual(['runtime-live'])
  expect(runtime['acceptedRendererMobileSnapshotByWorktree'].has(TEST_WORKTREE_ID)).toBe(false)

  sync([publication()])
  const returned = await list()
  expect(returned.publicationEpoch).toBe('renderer-1')
  expect(returned.tabs.map((tab) => tab.id)).toEqual(['renderer-tab', 'runtime-live'])
  expect(returned.snapshotVersion).toBeGreaterThan(detached.snapshotVersion)
  expect(runtime['isRendererOwnedMobileBrowserTab'](publication(), rendererTab)).toBe(true)

  livePages.clear()
  sync([publication()])
  expect((await list()).tabs.map((tab) => tab.id)).toEqual(['renderer-tab'])
  sync([publication('renderer-2')])
  await expect(
    runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, rendererTab.id, {
      expectedPublicationEpoch: 'renderer-1'
    })
  ).resolves.toMatchObject({ refused: true, refusalReason: 'stale-publication' })
  expect((await list()).publicationEpoch).toBe('renderer-2')
})

it.each([false, true])(
  'retires dead client rows without offscreen=%s confusing renderer ownership',
  async (offscreen) => {
    const { runtime, sync, list } = browserRuntime()
    if (!offscreen) {
      runtime.setOffscreenBrowserBackend(null)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only window availability is read on this inventory path; the Electron test harness otherwise returns no windows.
      const windowHost = runtime as unknown as { getAvailableAuthoritativeWindow(): unknown }
      vi.spyOn(windowHost, 'getAvailableAuthoritativeWindow').mockReturnValue({})
    }
    sync([publication()])
    const pages = getRuntimeBrowserPageRegistry(runtime)
    const placement = {
      kind: 'client' as const,
      browserHostClientId: 'phone',
      browserHostGeneration: 1,
      pageHostGeneration: 1
    }
    pages.publishClientPage({
      browserPageId: 'client-page',
      workspaceId: TEST_WORKTREE_ID,
      browserProfileId: 'profile',
      executionHostKey: 'host',
      placement,
      url: 'https://client.example/',
      loading: false,
      active: false
    })
    runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)
    expect((await list()).tabs.map((tab) => tab.id)).toEqual(['renderer-tab', 'client-page'])
    expect(pages.retirePage('client-page', placement)).toBe(true)
    runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)
    const retired = await list()
    expect(retired.tabs.map((tab) => tab.id)).toEqual(['renderer-tab'])
    expect(retired.publicationEpoch).toBe('renderer-1')
    expect(retired.tabGroups?.flatMap((group) => group.tabOrder)).not.toContain('client-page')
    expect(retired.tabGroups?.flatMap((group) => group.tabOrder)).toContain('renderer-tab')
  }
)

it('does not tombstone a renderer browser when the acknowledged close fails', async () => {
  const { runtime, sync, list } = browserRuntime()
  sync([publication()])
  const closeSessionTab = vi.fn(async () => {
    throw new Error('renderer_disconnected')
  })
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    closeSessionTab,
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  const forgetTabs = vi.spyOn(runtime['clientSessionTabSelections'], 'forgetTabs')
  await expect(
    runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, rendererTab.browserWorkspaceId)
  ).rejects.toThrow('renderer_disconnected')
  expect(closeSessionTab).toHaveBeenCalledWith(rendererTab.id, TEST_WORKTREE_ID)
  expect(forgetTabs).not.toHaveBeenCalled()
  expect((await list()).tabs.map((tab) => tab.id)).toEqual(['renderer-tab'])
})

it('lists only pages the offscreen backend owns when the bridge also lists desktop webviews', async () => {
  const closeTab = vi.fn(async (_pageId: string) => {})
  // A saved workspace session sends list and graph sync through hydrate's runtime-owned merge.
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
  const { runtime, sync, addPage, addDesktopPage, list } = browserRuntime(closeTab, runtimeStore)
  sync([publication()])
  addDesktopPage('renderer-page')
  // A background page of the same desktop browser workspace is absent from the renderer's publication.
  addDesktopPage('background-desktop-page')
  addPage('separate-runtime-page')
  runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)
  await list()
  sync([publication('renderer-1', 2)])
  runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)

  const snapshot = await list()
  expect(snapshot.tabs.map((tab) => tab.id)).toEqual(['renderer-tab', 'separate-runtime-page'])
  expect(snapshot.publicationEpoch).toBe('renderer-1')
  expect(snapshot.tabGroups?.flatMap((group) => group.tabOrder)).toEqual([
    'renderer-tab',
    'separate-runtime-page'
  ])
  await expect(
    runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'separate-runtime-page')
  ).resolves.toMatchObject({ closed: true })
  expect(closeTab).toHaveBeenCalledWith('separate-runtime-page')
  expect(closeTab).not.toHaveBeenCalledWith(rendererTab.browserPageId)
})

it('keeps a replacement client page through a stale placement retirement and retires only the live generation', async () => {
  const { runtime, sync, list } = browserRuntime()
  sync([publication()])
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

it('finishes a pending runtime close after renderer detach without losing other pages or revived renderer groups', async () => {
  const closing = Promise.withResolvers<void>()
  const closeTab = vi.fn(async (_pageId: string) => closing.promise)
  const { runtime, livePages, sync, addPage, list } = browserRuntime(closeTab)
  sync([publication()])
  addPage('closing-page')
  addPage('surviving-page')
  runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)
  const close = runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'closing-page', {
    expectedPublicationEpoch: 'renderer-1'
  })
  await vi.waitFor(() => expect(closeTab).toHaveBeenCalledWith('closing-page'))

  sync([])
  const detached = await list()
  expect(detached.tabs.map((tab) => tab.id)).toEqual(['closing-page', 'surviving-page'])
  expect(detached.publicationEpoch).toMatch(/^headless-hydrated:/)
  livePages.delete('closing-page')
  closing.resolve()
  await expect(close).resolves.toMatchObject({ closed: true })
  const closedWhileDetached = await list()
  expect(closedWhileDetached.tabs.map((tab) => tab.id)).toEqual(['surviving-page'])
  expect(closedWhileDetached.tabGroups?.flatMap((group) => group.tabOrder)).not.toContain(
    'closing-page'
  )

  sync([publication('renderer-returned')])
  const returned = await list()
  expect(returned.publicationEpoch).toBe('renderer-returned')
  expect(returned.tabs.map((tab) => tab.id)).toEqual(['renderer-tab', 'surviving-page'])
  expect(returned.tabGroups?.flatMap((group) => group.tabOrder)).toEqual([
    'renderer-tab',
    'surviving-page'
  ])
  expect(returned.snapshotVersion).toBeGreaterThan(closedWhileDetached.snapshotVersion)
  expect(closeTab).toHaveBeenCalledTimes(1)
})

it('keeps the headless publication epoch while serve browser pages change', async () => {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
  const pages: BrowserTabInfo[] = []
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab: vi.fn(), ownsTab: () => true })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the bridge inventory is used by this lifecycle test.
  runtime.setAgentBrowserBridge({ tabList: () => ({ tabs: [...pages] }) } as never)
  const addPage = (browserPageId: string) => {
    pages.push({ browserPageId, index: pages.length, title: browserPageId, url: '', active: false })
    runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)
  }
  const list = () => runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  addPage('serve-page-1')
  const first = await list()
  addPage('serve-page-2')
  const second = await list()

  // Clients fence lifecycle closes by epoch; content changes must only bump the version.
  expect(second.tabs.map((tab) => tab.id)).toContain('serve-page-2')
  expect(second.publicationEpoch).toBe(first.publicationEpoch)
  expect(second.snapshotVersion).toBeGreaterThan(first.snapshotVersion)
})

it('lists a runtime page once when its id collides with a renderer row', async () => {
  const { runtime, sync, addPage, list } = browserRuntime()
  sync([publication()])
  addPage(rendererTab.id)
  runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)

  const ids = (await list()).tabs.map((tab) => tab.id)
  expect(ids.filter((id) => id === rendererTab.id)).toHaveLength(1)
})
