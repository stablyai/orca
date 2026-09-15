/**
 * #14552: agent-opened offscreen browser tabs were never bounded and never reclaimed. A headless
 * runtime reached 9 open tabs / 6 renderers of 220-480 MB in one working day, and `tab close`
 * came back `runtime_error` on pages whose renderer had stopped answering — leaving both the tab
 * and its process behind. These cover the cap at its boundary and the forced reclaim.
 */
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  windows: [] as MockBrowserWindow[],
  BrowserWindow: vi.fn(),
  nextOsProcessId: 5000
}))

class MockWebContents extends EventEmitter {
  readonly id: number
  readonly osProcessId: number

  constructor(id: number, osProcessId: number) {
    super()
    this.id = id
    this.osProcessId = osProcessId
  }

  getOSProcessId(): number {
    return this.osProcessId
  }

  loadURL(): Promise<void> {
    queueMicrotask(() => this.emit('did-finish-load'))
    return Promise.resolve()
  }
}

class MockBrowserWindow {
  readonly webContents: MockWebContents
  private destroyed = false

  constructor() {
    this.webContents = new MockWebContents(mocks.windows.length + 1, mocks.nextOsProcessId++)
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
import {
  DEFAULT_MAX_OFFSCREEN_BROWSER_TABS,
  MAX_OFFSCREEN_BROWSER_TABS_ENV,
  OFFSCREEN_BROWSER_TAB_CAPACITY_CODE,
  resolveOffscreenBrowserTabCap
} from './offscreen-browser-tab-capacity'
import {
  reclaimRendererProcess,
  type RendererProcessControl
} from './offscreen-renderer-process-reclaim'

type BrowserManagerDouble = {
  registerOffscreenGuest: Mock<() => boolean>
  unregisterGuest: Mock<(browserPageId: string) => void>
}

/**
 * Every backend gets an injected process control: the default one signals real OS pids, and the
 * mock windows hand out numbers that belong to unrelated processes on the host.
 */
function createBackend(options: {
  browserManager: BrowserManagerDouble
  maxTabs?: number
  getAgentBrowserBridge?: () => { onPageClosed: (browserPageId: string) => Promise<void> }
  rendererProcessControl?: RendererProcessControl
}): OffscreenBrowserBackend {
  const { browserManager, ...rest } = options
  return new OffscreenBrowserBackend(browserManager as never, {
    rendererProcessControl: { isAlive: () => false, kill: () => {} },
    ...rest
  })
}

function openTab(backend: OffscreenBrowserBackend, browserPageId: string): Promise<unknown> {
  return backend.createTab({ browserPageId, url: 'about:blank', worktreeId: 'wt' })
}

beforeEach(() => {
  mocks.windows.length = 0
  mocks.nextOsProcessId = 5000
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
  const statics = mocks.BrowserWindow as unknown as {
    getAllWindows: () => MockBrowserWindow[]
  }
  statics.getAllWindows = () => mocks.windows.filter((window) => !window.isDestroyed())
})

describe('offscreen browser tab cap', () => {
  it('refuses the create that would exceed the cap and keeps the open tabs usable', async () => {
    const browserManager = { registerOffscreenGuest: vi.fn(() => true), unregisterGuest: vi.fn() }
    const backend = createBackend({ browserManager, maxTabs: 2 })

    await openTab(backend, 'page-1')
    await openTab(backend, 'page-2')
    await expect(openTab(backend, 'page-3')).rejects.toMatchObject({
      code: OFFSCREEN_BROWSER_TAB_CAPACITY_CODE
    })

    // Why the window count: a refusal that still constructed the BrowserWindow would leak the very
    // renderer the cap exists to prevent, whatever the caller was told.
    expect(mocks.windows).toHaveLength(2)
    expect(backend.getWebContentsId('page-1')).toBe(1)
    expect(backend.getWebContentsId('page-2')).toBe(2)
    expect(backend.getWebContentsId('page-3')).toBeNull()
  })

  it('admits a new tab once a closed one gives its slot back', async () => {
    const browserManager = { registerOffscreenGuest: vi.fn(() => true), unregisterGuest: vi.fn() }
    const backend = createBackend({ browserManager, maxTabs: 1 })

    await openTab(backend, 'page-1')
    await expect(openTab(backend, 'page-2')).rejects.toMatchObject({
      code: OFFSCREEN_BROWSER_TAB_CAPACITY_CODE
    })
    await backend.closeTab('page-1')
    await expect(openTab(backend, 'page-2')).resolves.toEqual({ browserPageId: 'page-2' })
  })

  it('does not spend a slot on a page the registry refused', async () => {
    const browserManager = { registerOffscreenGuest: vi.fn(() => true), unregisterGuest: vi.fn() }
    browserManager.registerOffscreenGuest.mockReturnValueOnce(false)
    const backend = createBackend({ browserManager, maxTabs: 1 })

    await expect(openTab(backend, 'refused-page')).rejects.toThrow('was refused')
    await expect(openTab(backend, 'page-1')).resolves.toEqual({ browserPageId: 'page-1' })
  })

  it('resolves the cap from the environment and ignores unusable overrides', () => {
    expect(resolveOffscreenBrowserTabCap({ [MAX_OFFSCREEN_BROWSER_TABS_ENV]: '8' })).toBe(8)
    expect(resolveOffscreenBrowserTabCap({})).toBe(DEFAULT_MAX_OFFSCREEN_BROWSER_TABS)
    for (const override of ['0', '-1', '2.5', 'many', '']) {
      expect(resolveOffscreenBrowserTabCap({ [MAX_OFFSCREEN_BROWSER_TABS_ENV]: override })).toBe(
        DEFAULT_MAX_OFFSCREEN_BROWSER_TABS
      )
    }
    expect(resolveOffscreenBrowserTabCap({ [MAX_OFFSCREEN_BROWSER_TABS_ENV]: '65' })).toBe(64)
    expect(resolveOffscreenBrowserTabCap({ [MAX_OFFSCREEN_BROWSER_TABS_ENV]: '100' })).toBe(64)
  })
})

describe('offscreen browser tab reclaim', () => {
  it('closes the page when the renderer never answers the retirement', async () => {
    const browserManager = { registerOffscreenGuest: vi.fn(() => true), unregisterGuest: vi.fn() }
    // Never settles: the wedged renderer of #14552, which used to hold the close open forever.
    const onPageClosed = vi.fn(() => new Promise<void>(() => {}))
    const backend = createBackend({
      browserManager,
      getAgentBrowserBridge: () => ({ onPageClosed })
    })

    await openTab(backend, 'page-1')
    await backend.closeTab('page-1')

    expect(mocks.windows[0].isDestroyed()).toBe(true)
    expect(browserManager.unregisterGuest).toHaveBeenCalledWith('page-1')
    expect(backend.getWebContentsId('page-1')).toBeNull()
  })

  it('kills the renderer process that outlived its destroyed window', async () => {
    const browserManager = { registerOffscreenGuest: vi.fn(() => true), unregisterGuest: vi.fn() }
    const killed: number[] = []
    const backend = createBackend({
      browserManager,
      rendererProcessControl: {
        isAlive: (osProcessId) => !killed.includes(osProcessId),
        kill: (osProcessId) => killed.push(osProcessId)
      }
    })

    await openTab(backend, 'page-1')
    const osProcessId = mocks.windows[0].webContents.getOSProcessId()
    await backend.closeTab('page-1')

    expect(killed).toEqual([osProcessId])
  })

  it('leaves a renderer shared with another live page alone', async () => {
    const control = { isAlive: () => true, kill: vi.fn() }
    const isShared = vi.fn(() => true)

    await expect(
      reclaimRendererProcess(4321, { control, isShared, graceMs: 0, pollMs: 1 })
    ).resolves.toBe('shared')
    expect(control.kill).not.toHaveBeenCalled()
  })

  it('reports the ordinary exit without signalling anything', async () => {
    const control = { isAlive: () => false, kill: vi.fn() }

    await expect(
      reclaimRendererProcess(4321, { control, isShared: () => false, graceMs: 50, pollMs: 1 })
    ).resolves.toBe('exited')
    expect(control.kill).not.toHaveBeenCalled()
  })
})
