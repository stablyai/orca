import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const workSession = { name: 'work' }
  const otherSession = { name: 'other' }
  // Page id → guest webContents and its workspace.
  const pages = new Map<string, { id: number; session: object; worktreeId: string }>()
  return { workSession, otherSession, pages, createTab: vi.fn() }
})

vi.mock('electron', () => ({
  webContents: {
    fromId: (id: number) => {
      const page = [...mocks.pages.values()].find((entry) => entry.id === id)
      return page ? { id, session: page.session, isDestroyed: () => false } : undefined
    }
  }
}))
vi.mock('../browser-manager', () => ({
  browserManager: {
    getGuestWebContentsId: (pageId: string) => mocks.pages.get(pageId)?.id ?? null,
    getWebContentsIdByTabId: () =>
      new Map([...mocks.pages].map(([pageId, page]) => [pageId, page.id])),
    getWorktreeIdForTab: (pageId: string) => mocks.pages.get(pageId)?.worktreeId
  }
}))
vi.mock('../../runtime/browser/browser-tab-renderer-create', () => ({
  createBrowserTabInRenderer: mocks.createTab
}))
vi.mock('../../runtime/browser/browser-tab-renderer-close', () => ({}))
vi.mock('../../runtime/browser/browser-tab-renderer-activate', () => ({}))
vi.mock('../../ipc/browser-tab-registration-wait', () => ({ waitForTabRegistration: vi.fn() }))
vi.mock('./browser-extension-api-host', () => ({ emitBrowserExtensionEvent: vi.fn() }))
vi.mock('./browser-extension-popup-host', () => ({ closeBrowserExtensionPopup: vi.fn() }))
vi.mock('./browser-extension-active-tab', () => ({}))
vi.mock('./browser-extension-support', () => ({ isBrowserExtensionSupportEnabled: () => false }))
vi.mock('./browser-extension-session-loader', () => ({
  getBrowserExtensionProfile: (id: string) => ({ id, partition: `persist:${id}` }),
  getBrowserExtensionSessionForProfile: (id: string) =>
    id === 'work' ? mocks.workSession : mocks.otherSession
}))
vi.mock('./browser-extension-window-model', () => ({
  getBrowserExtensionMainWindow: () => ({ id: 1 })
}))

const { openBrowserExtensionTab, recentWorktreeIdForBrowserProfile, recordActiveBrowserPage } =
  await import('./browser-extension-tab-model')
const { watchBrowserMainWindowReadiness } = await import('../browser-main-window-readiness')

/** Orca's main window; its renderer reports readiness on the per-window IPC channel. */
function mainWindow() {
  const contents = Object.assign(new EventEmitter(), { ipc: new EventEmitter() })
  const window = { id: 1, webContents: contents, isDestroyed: () => false }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readiness reads only id, isDestroyed and these two emitters.
  watchBrowserMainWindowReadiness(window as unknown as Electron.BrowserWindow)
  return {
    rendererReady: () => contents.ipc.emit('browser:tabRequestsReady'),
    reload: () => contents.emit('did-navigate')
  }
}

beforeEach(() => {
  mocks.pages.clear()
  mocks.createTab.mockReset()
  mainWindow().rendererReady()
})

describe('where an extension tab goes when no workspace is active', () => {
  it("prefers the active page's workspace when that page is in the profile", () => {
    mocks.pages.set('a', { id: 11, session: mocks.workSession, worktreeId: 'wt-a' })
    mocks.pages.set('b', { id: 12, session: mocks.workSession, worktreeId: 'wt-b' })
    recordActiveBrowserPage('b')
    expect(recentWorktreeIdForBrowserProfile('work')).toBe('wt-b')
  })

  it("otherwise uses any open tab in the profile, never another profile's workspace", () => {
    mocks.pages.set('a', { id: 11, session: mocks.otherSession, worktreeId: 'wt-other' })
    mocks.pages.set('b', { id: 12, session: mocks.workSession, worktreeId: 'wt-work' })
    recordActiveBrowserPage('a')
    expect(recentWorktreeIdForBrowserProfile('work')).toBe('wt-work')
    mocks.pages.delete('b')
    expect(recentWorktreeIdForBrowserProfile('work')).toBeUndefined()
  })

  it('passes that workspace to the renderer as the fallback', async () => {
    mocks.pages.set('a', { id: 11, session: mocks.workSession, worktreeId: 'wt-a' })
    mocks.createTab.mockImplementation(async () => {
      mocks.pages.set('new', { id: 13, session: mocks.workSession, worktreeId: 'wt-a' })
      return { browserPageId: 'new' }
    })
    expect(await openBrowserExtensionTab('work', 'https://welcome.test', true)).toBe(13)
    expect(mocks.createTab).toHaveBeenCalledWith(
      expect.anything(),
      'https://welcome.test',
      undefined,
      'work',
      'persist:work',
      true,
      undefined,
      'wt-a'
    )
  })
})

describe('an extension tab opened while Orca starts', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for the window and its restored workspaces, then opens', async () => {
    const window = mainWindow()
    mocks.createTab.mockImplementation(async () => {
      mocks.pages.set('welcome', { id: 21, session: mocks.workSession, worktreeId: 'wt-a' })
      return { browserPageId: 'welcome' }
    })
    const opening = openBrowserExtensionTab('work', 'https://welcome.test', true)
    await Promise.resolve()
    expect(mocks.createTab).not.toHaveBeenCalled()
    window.rendererReady()
    await expect(opening).resolves.toBe(21)

    // A reload waits for the new document to restore again.
    window.reload()
    const reopening = openBrowserExtensionTab('work', 'https://welcome.test', true)
    await Promise.resolve()
    expect(mocks.createTab).toHaveBeenCalledTimes(1)
    window.rendererReady()
    await expect(reopening).resolves.toBe(21)
  })

  it('fails cleanly when the window never becomes ready', async () => {
    vi.useFakeTimers()
    mainWindow()
    const opening = openBrowserExtensionTab('work', 'https://welcome.test', true)
    const failed = expect(opening).rejects.toThrow('Orca has no window to open a tab in')
    await vi.advanceTimersByTimeAsync(30_000)
    await failed
    expect(mocks.createTab).not.toHaveBeenCalled()
  })
})
