import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  windows: [] as MockBrowserWindow[],
  BrowserWindow: vi.fn(),
  finishLoads: true
}))

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
    return false
  }

  loadURL(): Promise<void> {
    if (mocks.finishLoads) {
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
    this.webContents.emit('destroyed')
  }
}

vi.mock('electron', () => ({ BrowserWindow: mocks.BrowserWindow }))
vi.mock('../sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    getDefaultProfile: vi.fn(() => ({ id: 'default', partition: 'persist:orca-browser' })),
    attachExtensions: vi.fn()
  }
}))

import { OffscreenBrowserBackend } from './offscreen-browser-backend'
import { isWorkspaceDocPageId } from '../document-preview/doc-preview-guest-policy'

describe('OffscreenBrowserBackend lifecycle', () => {
  beforeEach(() => {
    mocks.windows.length = 0
    mocks.finishLoads = true
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
})
