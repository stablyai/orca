import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  windows: [] as MockBrowserWindow[],
  BrowserWindow: vi.fn(),
  finishLoads: true
}))

class MockWebContents extends EventEmitter {
  readonly id: number

  constructor(id: number) {
    super()
    this.id = id
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
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    getDefaultProfile: vi.fn(() => ({ id: 'default', partition: 'persist:orca-browser' }))
  }
}))

import { OffscreenBrowserBackend } from './offscreen-browser-backend'
import { installDocPreviewGuestPolicy, isWorkspaceDocPageId } from './doc-preview-guest-policy'
import { mintDocPreviewGrant } from './doc-preview-grant-registry'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'

/** The real door's answer, so the backend is tested against the refusal it will actually get. */
function registerOffscreenGuestLikeBrowserManager({
  browserPageId
}: {
  browserPageId: string
}): boolean {
  return !isWorkspaceDocPageId(browserPageId)
}

/**
 * A page the document half of the registry really owns. Built rather than named, because the door
 * refuses on registry membership now — a made-up id would be admitted and prove nothing.
 */
function registerWorkspaceDocPage(browserPageId: string): void {
  const grant = mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html',
    browserPageId
  })
  const guest = {
    isFocused: () => false,
    isDestroyed: () => false,
    getURL: () => buildDocPreviewUrl(grant.id, grant.entryRelativePath),
    on: vi.fn(),
    once: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn()
  }
  installDocPreviewGuestPolicy(guest as never, { id: 1, send: vi.fn() })
}

describe('OffscreenBrowserBackend lifecycle', () => {
  beforeEach(() => {
    mocks.windows.length = 0
    mocks.finishLoads = true
    mocks.BrowserWindow.mockImplementation(
      function BrowserWindowMock(this: {
        webContents: MockWebContents
        isDestroyed: () => boolean
        destroy: () => void
      }) {
        const window = new MockBrowserWindow()
        this.webContents = window.webContents
        this.isDestroyed = window.isDestroyed.bind(window)
        this.destroy = window.destroy.bind(window)
      }
    )
  })

  it('settles a pending load and removes its waiters when the page is destroyed', async () => {
    vi.useFakeTimers()
    mocks.finishLoads = false
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    const backend = new OffscreenBrowserBackend(browserManager as never)

    await backend.createTab({
      browserPageId: 'page-1',
      url: 'https://example.com',
      worktreeId: 'wt'
    })
    const webContents = mocks.windows[0].webContents
    expect(webContents.listenerCount('did-finish-load')).toBe(1)
    expect(webContents.listenerCount('did-fail-load')).toBe(1)

    await backend.closeTab('page-1')
    expect(webContents.listenerCount('did-finish-load')).toBe(0)
    expect(webContents.listenerCount('did-fail-load')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  // Why the unregister assertion and not just the destroy: a refused id is one the document half
  // of the registry owns, and the teardown hook would cancel that preview's work on the way out.
  it('destroys a window whose registration was refused without unregistering the id', async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    const backend = new OffscreenBrowserBackend(browserManager as never)
    registerWorkspaceDocPage('doc-page-1')

    await expect(
      backend.createTab({
        browserPageId: 'doc-page-1',
        url: 'https://example.com',
        worktreeId: 'wt'
      })
    ).rejects.toThrow('was refused')

    expect(mocks.windows[0].isDestroyed()).toBe(true)
    expect(browserManager.unregisterGuest).not.toHaveBeenCalled()

    // Why shutdown and not the map: a refused id left behind is invisible until teardown walks it
    // and hands that id to the other authority after all.
    await backend.destroyAll()
    expect(browserManager.unregisterGuest).not.toHaveBeenCalled()
  })

  it('unregisters a closing page before awaiting owner retirement', async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    let releaseOwnerRetirement!: () => void
    const ownerRetirementBlocked = new Promise<void>((resolve) => {
      releaseOwnerRetirement = resolve
    })
    const onPageClosed = vi.fn(() => ownerRetirementBlocked)
    const backend = new OffscreenBrowserBackend(browserManager as never, {
      getAgentBrowserBridge: () => ({ onPageClosed })
    })

    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt' })
    await backend.createTab({ browserPageId: 'page-2', url: 'about:blank', worktreeId: 'wt' })
    const close = backend.closeTab('page-1')
    await vi.waitFor(() => expect(onPageClosed).toHaveBeenCalledWith('page-1'))
    const pageWasUnregisteredBeforeRetirement = browserManager.unregisterGuest.mock.calls.some(
      ([pageId]) => pageId === 'page-1'
    )
    releaseOwnerRetirement()
    await close

    expect(onPageClosed).toHaveBeenCalledOnce()
    expect(onPageClosed).not.toHaveBeenCalledWith('page-2')
    expect(backend.getWebContentsId('page-2')).toBe(2)
    expect(pageWasUnregisteredBeforeRetirement).toBe(true)
  })

  it('preserves a replacement page when the old window finishes closing', async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    let releaseOwnerRetirement!: () => void
    const ownerRetirementBlocked = new Promise<void>((resolve) => {
      releaseOwnerRetirement = resolve
    })
    const onPageClosed = vi.fn(() => ownerRetirementBlocked)
    const backend = new OffscreenBrowserBackend(browserManager as never, {
      getAgentBrowserBridge: () => ({ onPageClosed })
    })

    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt' })
    const close = backend.closeTab('page-1')
    await vi.waitFor(() => expect(onPageClosed).toHaveBeenCalledWith('page-1'))
    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt' })

    releaseOwnerRetirement()
    await close

    expect(backend.getWebContentsId('page-1')).toBe(2)
    expect(browserManager.unregisterGuest).toHaveBeenCalledTimes(1)
  })

  it('retires the helper when an offscreen renderer is destroyed unexpectedly', async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    const onPageClosed = vi.fn(async () => {})
    const backend = new OffscreenBrowserBackend(browserManager as never, {
      getAgentBrowserBridge: () => ({ onPageClosed })
    })

    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt' })
    mocks.windows[0].webContents.emit('destroyed')
    await vi.waitFor(() => expect(onPageClosed).toHaveBeenCalledWith('page-1'))
  })

  it('cleans every helper owner during backend shutdown', async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    const onPageClosed = vi.fn(async () => {})
    const backend = new OffscreenBrowserBackend(browserManager as never, {
      getAgentBrowserBridge: () => ({ onPageClosed })
    })

    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt' })
    await backend.createTab({ browserPageId: 'page-2', url: 'about:blank', worktreeId: 'wt' })
    await backend.destroyAll()

    expect(onPageClosed).toHaveBeenCalledTimes(2)
    expect(browserManager.unregisterGuest).toHaveBeenCalledWith('page-1')
    expect(browserManager.unregisterGuest).toHaveBeenCalledWith('page-2')
  })

  it('rejects a concurrent create while shutdown is draining owned pages', async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    let releaseOwnerRetirement!: () => void
    const ownerRetirementBlocked = new Promise<void>((resolve) => {
      releaseOwnerRetirement = resolve
    })
    const onPageClosed = vi.fn(() => ownerRetirementBlocked)
    const backend = new OffscreenBrowserBackend(browserManager as never, {
      getAgentBrowserBridge: () => ({ onPageClosed })
    })

    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt' })
    const shutdown = backend.destroyAll()
    await vi.waitFor(() => expect(onPageClosed).toHaveBeenCalledWith('page-1'))

    await expect(
      backend.createTab({ browserPageId: 'page-2', url: 'about:blank', worktreeId: 'wt' })
    ).rejects.toThrow('Offscreen browser backend is shutting down')

    releaseOwnerRetirement()
    await shutdown
    expect(mocks.windows).toHaveLength(1)
    expect(browserManager.unregisterGuest).toHaveBeenCalledWith('page-1')
    expect(browserManager.unregisterGuest).not.toHaveBeenCalledWith('page-2')
  })

  it('joins owner retirement started by an unexpected renderer destroy', async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    let releaseOwnerRetirement!: () => void
    const ownerRetirementBlocked = new Promise<void>((resolve) => {
      releaseOwnerRetirement = resolve
    })
    const onPageClosed = vi.fn(() => ownerRetirementBlocked)
    const backend = new OffscreenBrowserBackend(browserManager as never, {
      getAgentBrowserBridge: () => ({ onPageClosed })
    })

    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt' })
    mocks.windows[0].webContents.emit('destroyed')
    await vi.waitFor(() => expect(onPageClosed).toHaveBeenCalledWith('page-1'))

    const shutdown = backend.destroyAll()
    const outcome = await Promise.race([
      shutdown.then(() => 'settled'),
      new Promise<string>((resolve) => setImmediate(() => resolve('pending')))
    ])
    expect(outcome).toBe('pending')

    releaseOwnerRetirement()
    await shutdown
  })

  it('bounds concurrent helper retirements during shutdown', async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    let activeRetirements = 0
    let peakRetirements = 0
    const releases: (() => void)[] = []
    const onPageClosed = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          activeRetirements++
          peakRetirements = Math.max(peakRetirements, activeRetirements)
          releases.push(() => {
            activeRetirements--
            resolve()
          })
        })
    )
    const backend = new OffscreenBrowserBackend(browserManager as never, {
      getAgentBrowserBridge: () => ({ onPageClosed })
    })

    for (let index = 0; index < 6; index++) {
      await backend.createTab({
        browserPageId: `page-${index}`,
        url: 'about:blank',
        worktreeId: 'wt'
      })
    }

    const shutdown = backend.destroyAll()
    await vi.waitFor(() => expect(onPageClosed).toHaveBeenCalledTimes(4))
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(onPageClosed).toHaveBeenCalledTimes(6))
    releases.splice(0).forEach((release) => release())
    await shutdown

    expect(peakRetirements).toBe(4)
  })

  it('closes the page even when daemon retirement throws', async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    const backend = new OffscreenBrowserBackend(browserManager as never, {
      getAgentBrowserBridge: () => ({
        onPageClosed: vi.fn(async () => {
          throw new Error('daemon gone')
        })
      })
    })

    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt' })
    await expect(backend.closeTab('page-1')).resolves.toBeUndefined()
    expect(browserManager.unregisterGuest).toHaveBeenCalledWith('page-1')
  })
})
