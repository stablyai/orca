import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const workSession = { name: 'work' }
  const otherSession = { name: 'other' }
  // Page id → guest webContents and its workspace.
  const pages = new Map<string, { id: number; session: object; worktreeId: string }>()
  return { workSession, otherSession, pages, createTab: vi.fn(), active: false, tabs: true }
})

vi.mock('electron', () => ({
  webContents: {
    fromId: (id: number) => {
      const page = [...mocks.pages.values()].find((entry) => entry.id === id)
      return page ? { id, session: page.session, isDestroyed: () => false } : undefined
    }
  }
}))
vi.mock('../../guest-lifecycle/manager/browser-manager', () => ({
  browserManager: {
    getGuestWebContentsId: (pageId: string) => mocks.pages.get(pageId)?.id ?? null,
    getWebContentsIdByTabId: () =>
      new Map([...mocks.pages].map(([pageId, page]) => [pageId, page.id])),
    getWorktreeIdForTab: (pageId: string) => mocks.pages.get(pageId)?.worktreeId
  }
}))
vi.mock('../../../runtime/browser/tabs/browser-tab-renderer-create', () => ({
  createBrowserTabInRenderer: mocks.createTab
}))
vi.mock('../../../runtime/browser/tabs/browser-tab-renderer-close', () => ({}))
vi.mock('../../../runtime/browser/tabs/browser-tab-renderer-activate', () => ({}))
vi.mock('../../../ipc/browser/browser-tab-registration-wait', () => ({
  waitForTabRegistration: vi.fn()
}))
vi.mock('../api-runtime/browser-extension-api-host', () => ({ emitBrowserExtensionEvent: vi.fn() }))
vi.mock('../actions/browser-extension-popup-host', () => ({ closeBrowserExtensionPopup: vi.fn() }))
vi.mock('../permissions/browser-extension-active-tab', () => ({
  hasBrowserExtensionActiveTab: () => mocks.active
}))
vi.mock('../permissions/browser-extension-session-permissions', () => ({
  browserExtensionHostPatternsInSession: () => ['https://b.example/*']
}))
vi.mock('../browser-extension-support', () => ({ isBrowserExtensionSupportEnabled: () => false }))
vi.mock('../profile-sessions/browser-extension-session-loader', () => ({
  getBrowserExtensionProfile: (id: string) => ({ id, partition: `persist:${id}` }),
  getBrowserExtensionSessionForProfile: (id: string) =>
    id === 'work' ? mocks.workSession : mocks.otherSession
}))
vi.mock('./browser-extension-window-model', () => ({
  getBrowserExtensionMainWindow: () => ({ id: 1 })
}))

const { openBrowserExtensionTab, snapshotBrowserExtensionTab } =
  await import('./browser-extension-tab-model')
const { watchBrowserMainWindowReadiness } =
  await import('../../guest-lifecycle/browser-main-window-readiness')

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
    const opening = openBrowserExtensionTab('work', 'https://welcome.test', { active: true })
    await Promise.resolve()
    expect(mocks.createTab).not.toHaveBeenCalled()
    window.rendererReady()
    await expect(opening).resolves.toBe(21)

    // A reload waits for the new document to restore again.
    window.reload()
    const reopening = openBrowserExtensionTab('work', 'https://welcome.test', { active: true })
    await Promise.resolve()
    expect(mocks.createTab).toHaveBeenCalledTimes(1)
    window.rendererReady()
    await expect(reopening).resolves.toBe(21)
  })
})

it('filters a historical tab against its original document after navigation and permission removal', async () => {
  const { setBrowserExtensionGrantedPermissionsLookup } =
    await import('../api-runtime/browser-extension-namespace-registry')
  const { startBrowserExtensionDocument } = await import('./browser-extension-document-ids')
  const { dispatchBrowserExtensionEvent } =
    await import('../api-runtime/browser-extension-event-dispatch')
  const { flushWorkerQueue, beginWorkerPublication } =
    await import('../api-runtime/browser-extension-worker-event-stream')
  const { ensureHostSessionState, ensureWorkerContext, forgetHostSession } =
    await import('../api-runtime/browser-extension-contexts')
  const extension: Electron.Extension = {
    id: 'a'.repeat(32),
    name: '',
    path: '',
    url: '',
    version: '1',
    manifest: {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch uses only this extension lookup.
  const session = { extensions: { getExtension: () => extension } } as unknown as Electron.Session
  let url = 'https://a.example/private'
  let title = 'Private title'
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: document identity uses only this frame as a WeakMap key.
  const frame = {} as Electron.WebFrameMain
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all snapshot-read native methods are supplied here.
  const contents = {
    id: 8,
    session,
    mainFrame: frame,
    getURL: () => url,
    getTitle: () => title,
    isDestroyed: () => false,
    isLoading: () => false,
    isCurrentlyAudible: () => false,
    isAudioMuted: () => false
  } as unknown as Electron.WebContents
  const describe = snapshotBrowserExtensionTab({
    contents,
    index: 0,
    active: true,
    windowId: 1,
    windowType: 'normal'
  })
  const state = ensureHostSessionState(session, 'historical')
  const context = ensureWorkerContext(state, extension.id, '')
  beginWorkerPublication(context)
  mocks.tabs = true
  mocks.active = false
  setBrowserExtensionGrantedPermissionsLookup(() => (mocks.tabs ? ['tabs'] : []))
  dispatchBrowserExtensionEvent(
    new Map([[session, state]]),
    { session },
    'tabs',
    'onCreated',
    (candidate) => [describe(candidate)],
    vi.fn()
  )
  url = 'https://b.example/public'
  title = 'Later title'
  startBrowserExtensionDocument(frame)
  mocks.tabs = false
  mocks.active = true
  const send = vi.fn()
  context.stream = {
    connectionId: 'current',
    controller: new AbortController(),
    events: new Set(['tabs.onCreated']),
    filters: new Map(),
    published: true,
    send,
    close: () => {}
  }
  flushWorkerQueue(context, 'tabs.onCreated')
  expect(send.mock.calls).toEqual([
    [
      {
        namespace: 'tabs',
        event: 'onCreated',
        args: [
          {
            id: 8,
            index: 0,
            windowId: 1,
            active: true,
            highlighted: true,
            selected: true,
            pinned: false,
            discarded: false,
            autoDiscardable: true,
            incognito: false,
            groupId: -1,
            status: 'complete',
            audible: false,
            mutedInfo: { muted: false }
          }
        ]
      }
    ]
  ])
  forgetHostSession(session)
  setBrowserExtensionGrantedPermissionsLookup(() => [])
})
