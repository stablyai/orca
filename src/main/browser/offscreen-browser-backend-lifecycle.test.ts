import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  windows: [] as MockBrowserWindow[],
  BrowserWindow: vi.fn()
}))

class MockWebContents extends EventEmitter {
  static hangLoads = false

  constructor(readonly id: number) {
    super()
  }

  loadURL(): Promise<void> {
    if (!MockWebContents.hangLoads) {
      queueMicrotask(() => this.emit('did-finish-load'))
    }
    return Promise.resolve()
  }
}

class MockBrowserWindow {
  readonly webContents: MockWebContents
  private destroyed = false
  emitDestroyedOnDestroy = true

  constructor() {
    this.webContents = new MockWebContents(electronMocks.windows.length + 1)
    electronMocks.windows.push(this)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    if (this.emitDestroyedOnDestroy) {
      this.webContents.emit('destroyed')
    }
  }
}

vi.mock('electron', () => ({ BrowserWindow: electronMocks.BrowserWindow }))

vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: vi.fn(() => null),
    getDefaultProfile: vi.fn(() => ({
      id: 'default',
      partition: 'persist:orca-browser',
      userAgentMode: 'native'
    }))
  }
}))

import { OffscreenBrowserBackend } from './offscreen-browser-backend'

describe('OffscreenBrowserBackend lifecycle', () => {
  beforeEach(() => {
    electronMocks.windows.length = 0
    MockWebContents.hangLoads = false
    electronMocks.BrowserWindow.mockImplementation(function BrowserWindowMock() {
      return new MockBrowserWindow()
    })
  })

  it('keeps browser ownership registered until bridge cleanup completes', async () => {
    const order: string[] = []
    const browserManager = {
      registerOffscreenGuest: vi.fn(),
      unregisterGuest: vi.fn(() => order.push('unregister'))
    }
    const backend = new OffscreenBrowserBackend(
      browserManager as never,
      vi.fn(async () => {
        order.push('session-cleanup')
      })
    )

    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt-1' })
    await backend.closeTab('page-1')

    expect(order).toEqual(['session-cleanup', 'unregister'])
  })

  it('waits for stale cleanup before reusing a page id', async () => {
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const registrations = new Map<string, number>()
    const browserManager = {
      registerOffscreenGuest: vi.fn(
        ({ browserPageId, webContentsId }: { browserPageId: string; webContentsId: number }) => {
          registrations.set(browserPageId, webContentsId)
        }
      ),
      unregisterGuest: vi.fn((browserPageId: string) => registrations.delete(browserPageId))
    }
    const backend = new OffscreenBrowserBackend(
      browserManager as never,
      vi.fn(() => cleanup)
    )

    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt-1' })
    const close = backend.closeTab('page-1')
    const recreate = backend.createTab({
      browserPageId: 'page-1',
      url: 'about:blank',
      worktreeId: 'wt-1'
    })
    await Promise.resolve()
    expect(browserManager.registerOffscreenGuest).toHaveBeenCalledTimes(1)

    releaseCleanup()
    await close
    await recreate

    expect(browserManager.registerOffscreenGuest).toHaveBeenCalledTimes(2)
    expect(backend.getWebContentsId('page-1')).toBe(2)
    expect(registrations.get('page-1')).toBe(2)
  })

  it('contains asynchronous cleanup failures during destruction', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const backend = new OffscreenBrowserBackend(
      { registerOffscreenGuest: vi.fn(), unregisterGuest: vi.fn() } as never,
      vi.fn(async () => {
        throw new Error('cleanup failed')
      })
    )

    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt-1' })
    backend.destroyAll()
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[offscreen-browser] tab cleanup failed:', 'cleanup failed')
    )
    warn.mockRestore()
  })

  it('ignores a delayed destroyed event from a replaced page', async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(),
      unregisterGuest: vi.fn()
    }
    const backend = new OffscreenBrowserBackend(browserManager as never)

    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt-1' })
    const staleWindow = electronMocks.windows[0]
    staleWindow.emitDestroyedOnDestroy = false
    await backend.closeTab('page-1')
    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt-1' })

    staleWindow.webContents.emit('destroyed')

    expect(backend.getWebContentsId('page-1')).toBe(2)
  })

  it('removes load listeners when a page closes before navigation finishes', async () => {
    MockWebContents.hangLoads = true
    const backend = new OffscreenBrowserBackend({
      registerOffscreenGuest: vi.fn(),
      unregisterGuest: vi.fn()
    } as never)

    await backend.createTab({
      browserPageId: 'page-1',
      url: 'https://example.com',
      worktreeId: 'wt-1'
    })
    const webContents = electronMocks.windows[0].webContents
    expect(webContents.listenerCount('did-finish-load')).toBe(1)
    expect(webContents.listenerCount('destroyed')).toBe(2)

    await backend.closeTab('page-1')

    expect(webContents.listenerCount('did-finish-load')).toBe(0)
    expect(webContents.listenerCount('did-fail-load')).toBe(0)
    expect(webContents.listenerCount('destroyed')).toBe(0)
  })
})
