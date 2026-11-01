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
vi.mock('../sessions/browser-session-registry', () => ({
  browserSessionRegistry: {
    getDefaultProfile: vi.fn(() => ({ id: 'default', partition: 'persist:orca-browser' })),
    getProfile: vi.fn(() => null)
  }
}))

import { OffscreenBrowserBackend } from './offscreen-browser-backend'
import { isWorkspaceDocPageId } from '../document-preview/doc-preview-guest-policy'

function registerOffscreenGuestLikeBrowserManager({
  browserPageId
}: {
  browserPageId: string
}): boolean {
  return !isWorkspaceDocPageId(browserPageId)
}

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

    await backend.createTab({
      browserPageId: 'page-1',
      url: 'about:blank',
      worktreeId: 'wt',
      executionHostId: 'local'
    })
    const close = backend.closeTab('page-1')
    await vi.waitFor(() => expect(onPageClosed).toHaveBeenCalledWith('page-1'))
    await backend.createTab({
      browserPageId: 'page-1',
      url: 'about:blank',
      worktreeId: 'wt',
      executionHostId: 'local'
    })

    releaseOwnerRetirement()
    await close

    expect(backend.getWebContentsId('page-1')).toBe(2)
    expect(browserManager.unregisterGuest).toHaveBeenCalledTimes(1)
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

    await backend.createTab({
      browserPageId: 'page-1',
      url: 'about:blank',
      worktreeId: 'wt',
      executionHostId: 'local'
    })
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

  it('routes a restored page whose saved profile was deleted through the default profile', async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    const resolveWorkspaceRoutePartition = vi.fn().mockResolvedValue('persist:ssh-route')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createTab reads only these two BrowserManager members.
    const backend = new OffscreenBrowserBackend(browserManager as never, {
      resolveWorkspaceRoutePartition
    })

    await backend.createTab({
      browserPageId: 'page-1',
      url: 'http://127.0.0.1:3000/',
      worktreeId: 'wt',
      executionHostId: 'ssh:box',
      profileId: 'deleted-profile'
    })

    expect(resolveWorkspaceRoutePartition).toHaveBeenCalledWith({
      worktreeId: 'wt',
      executionHostId: 'ssh:box',
      browserProfileId: 'default'
    })
    expect(mocks.BrowserWindow.mock.lastCall?.[0].webPreferences.partition).toBe(
      'persist:ssh-route'
    )
  })

  // STA-13126: a server-hosted page must load an SSH workspace's localhost from that host.
  it("loads a workspace page on its host's route partition and never falls back to local egress", async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(registerOffscreenGuestLikeBrowserManager),
      unregisterGuest: vi.fn()
    }
    const resolveWorkspaceRoutePartition = vi
      .fn()
      .mockResolvedValueOnce('persist:ssh-route')
      .mockRejectedValueOnce(new Error("This workspace's SSH host isn't connected"))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createTab reads only these two BrowserManager members.
    const backend = new OffscreenBrowserBackend(browserManager as never, {
      resolveWorkspaceRoutePartition
    })

    await backend.createTab({
      browserPageId: 'page-1',
      url: 'http://127.0.0.1:3000/',
      worktreeId: 'wt',
      executionHostId: 'ssh:box'
    })
    expect(resolveWorkspaceRoutePartition).toHaveBeenCalledWith({
      worktreeId: 'wt',
      executionHostId: 'ssh:box',
      browserProfileId: 'default'
    })
    expect(mocks.BrowserWindow.mock.lastCall?.[0].webPreferences.partition).toBe(
      'persist:ssh-route'
    )

    await expect(
      backend.createTab({
        browserPageId: 'page-2',
        url: 'http://127.0.0.1:3000/',
        worktreeId: 'wt',
        executionHostId: 'ssh:box'
      })
    ).rejects.toThrow("SSH host isn't connected")
    expect(mocks.windows).toHaveLength(1)
  })
})
