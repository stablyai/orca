import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExtensionPageStart from '../extensions/profile-sessions/browser-extension-page-start'

const mocks = vi.hoisted(() => {
  const state: { extensionsReady: Promise<void> | null } = { extensionsReady: null }
  return Object.assign(state, {
    windows: new Array<MockBrowserWindow>(),
    BrowserWindow: vi.fn(),
    finishLoads: true,
    failLoads: false,
    loadedUrls: new Array<string>()
  })
})

class MockDebugger extends EventEmitter {
  attached = false

  isAttached(): boolean {
    return this.attached
  }

  detach(): void {
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }
}

class MockWebContents extends EventEmitter {
  readonly id: number
  readonly debugger = new MockDebugger()
  url = ''
  title = ''
  destroyed = false

  constructor(id: number) {
    super()
    this.id = id
  }

  getURL(): string {
    return this.url
  }

  getTitle(): string {
    return this.title
  }

  stopPainting(): void {}
  setFrameRate(): void {}
  isDestroyed(): boolean {
    return this.destroyed
  }

  loadURL(url: string): Promise<void> {
    mocks.loadedUrls.push(url)
    if (mocks.failLoads) {
      queueMicrotask(() => this.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', url, true))
    } else if (mocks.finishLoads) {
      queueMicrotask(() => this.emit('did-finish-load'))
    }
    return Promise.resolve()
  }
}

class MockBrowserWindow {
  readonly webContents: MockWebContents
  private destroyed = false

  constructor() {
    this.webContents = new MockWebContents(mocks.windows.length + 1)
    mocks.windows.push(this)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    this.webContents.destroyed = true
    this.webContents.emit('destroyed')
  }
}

vi.mock('electron', () => ({ BrowserWindow: mocks.BrowserWindow }))
vi.mock('../sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    getDefaultProfile: vi.fn(() => ({ id: 'default', partition: 'persist:orca-browser' })),
    getProfile: vi.fn((id: string) => ({ id, partition: `persist:orca-browser-${id}` })),
    attachExtensions: vi.fn()
  }
}))
vi.mock('../extensions/profile-sessions/browser-extension-page-start', async (importActual) => ({
  ...(await importActual<typeof ExtensionPageStart>()),
  whenBrowserExtensionsStartFor: () => mocks.extensionsReady
}))

import { OffscreenBrowserBackend } from './offscreen-browser-backend'

describe('OffscreenBrowserBackend lifecycle', () => {
  beforeEach(() => {
    mocks.windows.length = 0
    mocks.finishLoads = true
    mocks.failLoads = false
    mocks.loadedUrls.length = 0
    mocks.extensionsReady = null
    mocks.BrowserWindow.mockImplementation(function BrowserWindowMock(this: {
      webContents: MockWebContents
      isDestroyed: () => boolean
      destroy: () => void
    }) {
      const window = new MockBrowserWindow()
      this.webContents = window.webContents
      this.isDestroyed = window.isDestroyed.bind(window)
      this.destroy = window.destroy.bind(window)
    })
  })

  it('publishes safe page metadata while the offscreen guest retains its native URL', async () => {
    const onPageNavigated = vi.fn()
    const browserManager = {
      registerOffscreenGuest: () => true,
      unregisterGuest: () => {}
    }
    const backend = new OffscreenBrowserBackend(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the two manager methods used by create/close.
      browserManager as never,
      { onPageNavigated }
    )
    await backend.createTab({ browserPageId: 'private-page', url: 'about:blank', worktreeId: 'wt' })
    const guest = mocks.windows[0].webContents
    guest.url = 'https://kagi.com/search?token=offscreen-secret&q=one'
    guest.title = guest.url
    guest.emit('did-stop-loading')
    expect(onPageNavigated).toHaveBeenLastCalledWith({
      worktreeId: 'wt',
      pageId: 'private-page',
      url: 'https://kagi.com/search?q=one',
      title: 'https://kagi.com/search?q=one'
    })
    expect(guest.getURL()).toBe('https://kagi.com/search?token=offscreen-secret&q=one')
    await backend.destroyAll()
  })

  it('keeps the submitted address only until the first load settles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let startExtensions = (): void => {}
    mocks.extensionsReady = new Promise<void>((resolve) => (startExtensions = resolve))
    const browserManager = {
      registerOffscreenGuest: () => true,
      unregisterGuest: () => {},
      getWorktreeIdForTab: () => 'wt'
    }
    const backend = new OffscreenBrowserBackend(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the manager methods used by create, switch and close.
      browserManager as never
    )
    const privateUrl = 'https://kagi.com/search?token=offscreen-secret&q=one'
    await backend.createTab({ browserPageId: 'private-page', url: privateUrl, worktreeId: 'wt' })

    // Switched while extensions still hold the first load: the new page opens the same address.
    await backend.setTabProfile('private-page', 'work')
    mocks.failLoads = true
    startExtensions()
    await vi.waitFor(() => expect(mocks.loadedUrls).toEqual([privateUrl]))

    // That load failed with no committed URL; once it settles, a later switch must not resend the bearer.
    await new Promise((resolve) => setTimeout(resolve, 0))
    mocks.loadedUrls.length = 0
    await backend.setTabProfile('private-page', 'default')
    await vi.waitFor(() => expect(mocks.loadedUrls).toEqual(['https://kagi.com/search?q=one']))
    await backend.destroyAll()
    warn.mockRestore()
  })
})
