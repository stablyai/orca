import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionCaller } from './browser-extension-namespace-registry'

const mocks = vi.hoisted(() => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tab resolution uses session identity only.
  const workSession = { name: 'work' } as unknown as Electron.Session
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tab resolution uses session identity only.
  const otherSession = { name: 'other' } as unknown as Electron.Session
  const main = { id: 1, webContents: { id: 1 } }
  const pages = new Map<string, number>()
  function guest(id: number, session = workSession) {
    return {
      id,
      session,
      destroyed: false,
      hostWebContents: main.webContents,
      isDestroyed() {
        return this.destroyed
      },
      getType: () => 'webview',
      getURL: () => `https://page.test/${id}`,
      getTitle: () => `Page ${id}`,
      isLoading: () => false,
      isCurrentlyAudible: () => false,
      isAudioMuted: () => false
    }
  }
  const contents = new Map<number, ReturnType<typeof guest>>()
  const popouts = new Map<number, { id: number; webContents: ReturnType<typeof guest> }>()
  const discarded: {
    browserPageId: string
    tabId: number
    session: Electron.Session
    url: string
    title: string
  }[] = []
  const counts = { lookups: 0, registries: 0, discardedReads: 0 }
  const hostPatterns: string[] = []
  function addGuest(id: number, session = workSession, registered = true) {
    const entry = guest(id, session)
    contents.set(id, entry)
    if (registered) {
      pages.set(`page-${id}`, id)
    }
    return entry
  }
  return {
    workSession,
    otherSession,
    main,
    pages,
    contents,
    popouts,
    discarded,
    counts,
    addGuest,
    hasMain: true,
    activeGrants: new Set<number>(),
    hostPatterns
  }
})

vi.mock('electron', () => ({
  webContents: {
    fromId: (id: number) => {
      mocks.counts.lookups += 1
      return mocks.contents.get(id)
    }
  }
}))
vi.mock('../browser-manager', () => ({
  browserManager: {
    getWebContentsIdByTabId: () => {
      mocks.counts.registries += 1
      return mocks.pages
    },
    getGuestWebContentsId: (pageId: string) => mocks.pages.get(pageId) ?? null
  }
}))
vi.mock('../../runtime/browser/browser-tab-renderer-create', () => ({}))
vi.mock('../../runtime/browser/browser-tab-renderer-close', () => ({}))
vi.mock('../../runtime/browser/browser-tab-renderer-activate', () => ({}))
vi.mock('../../ipc/browser-tab-registration-wait', () => ({}))
vi.mock('./browser-extension-api-host', () => ({ emitBrowserExtensionEvent: vi.fn() }))
vi.mock('./browser-extension-popup-host', () => ({ closeBrowserExtensionPopup: vi.fn() }))
vi.mock('./browser-extension-support', () => ({ isBrowserExtensionSupportEnabled: () => false }))
vi.mock('./browser-extension-session-loader', () => ({}))
vi.mock('../browser-main-window-readiness', () => ({}))
vi.mock('./browser-extension-active-tab', () => ({
  hasBrowserExtensionActiveTab: (_extensionId: string, tabId: number) =>
    mocks.activeGrants.has(tabId)
}))
vi.mock('./api/permissions', () => ({
  browserExtensionHostPatternsInSession: () => mocks.hostPatterns
}))
vi.mock('./api/tabs-capture', () => ({ captureVisibleTabMethod: {} }))
vi.mock('./api/tabs-page-methods', () => ({ tabsPageMethods: {} }))
vi.mock('./browser-extension-discarded-tabs', () => ({
  FIRST_DISCARDED_BROWSER_TAB_ID: 2_000_000_000,
  listDiscardedBrowserTabs: () => {
    mocks.counts.discardedReads += 1
    return mocks.discarded
  },
  findDiscardedBrowserTabForPage: (pageId: string) => {
    mocks.counts.discardedReads += 1
    return mocks.discarded.find((tab) => tab.browserPageId === pageId) ?? null
  }
}))
vi.mock('./browser-extension-window-model', () => ({
  getBrowserExtensionMainWindow: () => (mocks.hasMain ? mocks.main : null),
  getLastFocusedBrowserExtensionWindowId: () => 1,
  getPopoutWindowForWebContents: (contents: { id: number }) =>
    [...mocks.popouts.values()].find((window) => window.webContents.id === contents.id) ?? null,
  listPopoutWindowsInSession: (session: Electron.Session) =>
    [...mocks.popouts.values()].filter((window) => window.webContents.session === session),
  listBrowserExtensionWindows: (session: Electron.Session) => [
    ...(mocks.hasMain ? [{ window: mocks.main, type: 'normal' }] : []),
    ...[...mocks.popouts.values()]
      .filter((window) => window.webContents.session === session)
      .map((window) => ({ window, type: 'popup' }))
  ]
}))

const { listBrowserExtensionTabs, recordActiveBrowserPage, resolveBrowserExtensionTab } =
  await import('./browser-extension-tab-model')
const { registerTabsNamespace } = await import('./api/tabs')
const { getBrowserExtensionNamespace } = await import('./browser-extension-namespace-registry')

function caller(permissions: string[] = ['tabs']): BrowserExtensionCaller {
  const extension: Electron.Extension = {
    id: 'a'.repeat(32),
    manifest: { permissions },
    name: 'Tab resolution fixture',
    path: '',
    url: `chrome-extension://${'a'.repeat(32)}/`,
    version: '1.0.0'
  }
  return { extension, session: mocks.workSession, browserProfileId: 'work', fromWorker: true }
}

function queryTabs(nativeTabs: Record<string, unknown>[], query = {}, target = caller()) {
  const method = getBrowserExtensionNamespace('tabs')?.methods.query
  if (!method) {
    throw new Error('tabs.query is not registered')
  }
  return method.invoke(target, [query, nativeTabs])
}

function resetCounts(): void {
  mocks.counts.lookups = 0
  mocks.counts.registries = 0
  mocks.counts.discardedReads = 0
}

beforeEach(() => {
  mocks.pages.clear()
  mocks.contents.clear()
  mocks.popouts.clear()
  mocks.discarded.length = 0
  mocks.activeGrants.clear()
  mocks.hostPatterns.length = 0
  mocks.hasMain = true
  recordActiveBrowserPage('none')
  resetCounts()
  registerTabsNamespace()
})

describe('extension tab enumeration', () => {
  it.each([10, 100])('lists %i tabs without rescanning the registry for each row', (count) => {
    for (let index = 0; index < count; index++) {
      mocks.addGuest(index + 10)
    }
    recordActiveBrowserPage('page-10')
    resetCounts()
    expect(
      listBrowserExtensionTabs(mocks.workSession).map((entry) => ({
        id: entry.contents.id,
        index: entry.index,
        active: entry.active
      }))
    ).toEqual(
      Array.from({ length: count }, (_, index) => ({
        id: index + 10,
        index,
        active: index === 0
      }))
    )
    expect(mocks.counts.lookups).toBeLessThanOrEqual(count * 4)
    expect(mocks.counts.registries).toBeLessThanOrEqual(1)
  })

  it.each([10, 100])(
    'queries %i native tabs through the registered API with linear lookups',
    (count) => {
      const nativeTabs = Array.from({ length: count }, (_, index) => {
        mocks.addGuest(index + 10)
        return { id: index + 10, url: `https://native.test/${index}`, title: `Native ${index}` }
      })
      recordActiveBrowserPage('page-10')
      resetCounts()
      expect(queryTabs(nativeTabs)).toEqual(
        nativeTabs.map((tab, index) =>
          expect.objectContaining({
            ...tab,
            index,
            active: index === 0,
            windowId: 1,
            discarded: false
          })
        )
      )
      expect(mocks.counts.lookups).toBeLessThanOrEqual(count * 4 + 1)
      expect(mocks.counts.registries).toBeLessThanOrEqual(2)
    }
  )

  it('resolves a discarded active page once per list or native query', () => {
    const nativeTabs = Array.from({ length: 100 }, (_, index) => {
      mocks.addGuest(index + 10)
      return { id: index + 10 }
    })
    mocks.discarded.push({
      browserPageId: 'saved',
      tabId: 2_000_000_000,
      session: mocks.workSession,
      url: 'https://saved.test',
      title: 'Saved'
    })
    recordActiveBrowserPage('saved')
    resetCounts()
    expect(listBrowserExtensionTabs(mocks.workSession).every((entry) => !entry.active)).toBe(true)
    expect(mocks.counts.discardedReads).toBeLessThanOrEqual(1)
    resetCounts()
    expect(queryTabs(nativeTabs, { active: true })).toEqual([
      expect.objectContaining({ id: 2_000_000_000, active: true, discarded: true })
    ])
    expect(mocks.counts.discardedReads).toBeLessThanOrEqual(3)
  })

  it('keeps profile isolation, global indices, active discarded tabs and early native guests', () => {
    mocks.addGuest(10)
    mocks.addGuest(20, mocks.otherSession)
    mocks.addGuest(30).destroyed = true
    mocks.addGuest(40)
    mocks.pages.set('alias', 10)
    mocks.addGuest(45, mocks.workSession, false)
    const popup = mocks.addGuest(50, mocks.workSession, false)
    mocks.popouts.set(2, { id: 2, webContents: popup })
    const foreignPopup = mocks.addGuest(60, mocks.otherSession, false)
    mocks.popouts.set(3, { id: 3, webContents: foreignPopup })
    mocks.discarded.push(
      {
        browserPageId: 'foreign',
        tabId: 2_000_000_000,
        session: mocks.otherSession,
        url: 'https://foreign.test',
        title: 'Foreign'
      },
      {
        browserPageId: 'saved',
        tabId: 2_000_000_001,
        session: mocks.workSession,
        url: 'https://saved.test',
        title: 'Saved'
      }
    )
    recordActiveBrowserPage('saved')
    expect(
      listBrowserExtensionTabs(mocks.workSession).map((entry) => ({
        id: entry.contents.id,
        index: entry.index,
        windowId: entry.windowId,
        active: entry.active
      }))
    ).toEqual([
      { id: 10, index: 0, windowId: 1, active: false },
      { id: 40, index: 2, windowId: 1, active: false },
      { id: 10, index: 0, windowId: 1, active: false },
      { id: 50, index: 0, windowId: 2, active: true }
    ])
    expect(queryTabs([60, 50, 45, 30, 20, 40, -1].map((id) => ({ id })))).toEqual([
      expect.objectContaining({ id: 40, index: 2, windowId: 1, active: false }),
      expect.objectContaining({ id: 45, index: 4, windowId: 1, active: false }),
      expect.objectContaining({
        id: 2_000_000_001,
        index: 5,
        windowId: 1,
        active: true,
        discarded: true
      }),
      expect.objectContaining({ id: 50, index: 0, windowId: 2, active: true })
    ])
    expect(queryTabs([{ id: 40 }, { id: 45 }], { active: true })).toEqual([
      expect.objectContaining({ id: 2_000_000_001, active: true })
    ])
  })

  it('keeps native query membership and URL permissions while restoring activeTab fields', () => {
    mocks.addGuest(10)
    mocks.addGuest(11)
    mocks.addGuest(12)
    mocks.addGuest(13)
    mocks.activeGrants.add(12)
    const noTabs = caller([])
    expect(queryTabs([{ id: 11 }], {}, noTabs)).toEqual([expect.objectContaining({ id: 11 })])
    expect(queryTabs([{ id: 11 }], {}, noTabs)).toEqual([
      expect.not.objectContaining({ url: expect.anything() })
    ])
    expect(queryTabs([{ id: 12 }], {}, noTabs)).toEqual([
      expect.objectContaining({ id: 12, url: 'https://page.test/12', title: 'Page 12' })
    ])
    expect(
      queryTabs([{ id: 13, url: 'https://native.test', title: 'Native' }], {}, noTabs)
    ).toEqual([expect.objectContaining({ id: 13, url: 'https://native.test', title: 'Native' })])
  })

  it('refreshes single-tab resolution after reorder, activation and destruction', () => {
    mocks.addGuest(10)
    const second = mocks.addGuest(20)
    expect(resolveBrowserExtensionTab(20)).toMatchObject({ index: 1, active: false })
    mocks.pages.clear()
    mocks.pages.set('page-20', 20)
    mocks.pages.set('page-10', 10)
    recordActiveBrowserPage('page-20')
    expect(resolveBrowserExtensionTab(20)).toMatchObject({ index: 0, active: true })
    second.destroyed = true
    expect(resolveBrowserExtensionTab(20)).toBeNull()
    expect(resolveBrowserExtensionTab(10)).toMatchObject({ index: 0 })
  })
})
