import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Display = { workArea: { x: number; y: number; width: number; height: number } }

const {
  instances,
  BrowserWindowMock,
  nativeThemeMock,
  appOnMock,
  appRemoveListenerMock,
  getAllDisplaysMock,
  installNavigationPolicyMock,
  sendToTrustedUIRendererMock,
  isMock
} = vi.hoisted(() => {
  const created: FakeWindow[] = []

  class FakeWindow {
    options: Electron.BrowserWindowConstructorOptions
    private handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    private onceHandlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    destroyed = false
    minimized = false
    fullscreen = false
    webContents = { id: created.length + 1, send: vi.fn(), isDestroyed: () => this.destroyed }
    bounds = { x: 100, y: 100, width: 960, height: 720 }
    focus = vi.fn()
    show = vi.fn()
    restore = vi.fn(() => {
      this.minimized = false
    })
    loadURL = vi.fn()
    loadFile = vi.fn()
    close = vi.fn(() => {
      this.destroyed = true
      this.emit('close')
      this.emit('closed')
    })

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      this.options = options
      created.push(this)
    }

    on(event: string, cb: (...args: unknown[]) => void): this {
      ;(this.handlers[event] ||= []).push(cb)
      return this
    }

    once(event: string, cb: (...args: unknown[]) => void): this {
      ;(this.onceHandlers[event] ||= []).push(cb)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers[event] ?? []) {
        cb(...args)
      }
      for (const cb of this.onceHandlers[event] ?? []) {
        cb(...args)
      }
    }

    isDestroyed(): boolean {
      return this.destroyed
    }
    isMinimized(): boolean {
      return this.minimized
    }
    isFullScreen(): boolean {
      return this.fullscreen
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return this.bounds
    }
  }

  return {
    instances: created,
    BrowserWindowMock: FakeWindow,
    nativeThemeMock: { shouldUseDarkColors: true },
    appOnMock: vi.fn(),
    appRemoveListenerMock: vi.fn(),
    getAllDisplaysMock: vi.fn((): Display[] => [
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
    ]),
    installNavigationPolicyMock: vi.fn(),
    sendToTrustedUIRendererMock: vi.fn(),
    isMock: { dev: false } as { dev: boolean }
  }
})

// Static helpers live on the constructor; broadcastPopoutOpenChanged uses
// BrowserWindow.getAllWindows(). Return the instances created in this test.
;(BrowserWindowMock as unknown as { getAllWindows: () => unknown[] }).getAllWindows = () =>
  instances

vi.mock('electron', () => ({
  app: { on: appOnMock, removeListener: appRemoveListenerMock },
  BrowserWindow: BrowserWindowMock,
  nativeTheme: nativeThemeMock,
  screen: { getAllDisplays: getAllDisplaysMock }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: isMock }))
vi.mock('../ipc/ui', () => ({ sendToTrustedUIRenderer: sendToTrustedUIRendererMock }))
vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: installNavigationPolicyMock
}))

import {
  createOrFocusDashboardPopout,
  closeDashboardPopout,
  isDashboardPopoutRenderer
} from './dashboard-popout-window'

type FakeWindow = InstanceType<typeof BrowserWindowMock>

function makeStore(ui: Record<string, unknown> = {}): {
  getUI: () => Record<string, unknown>
  updateUI: ReturnType<typeof vi.fn>
} {
  return { getUI: () => ui, updateUI: vi.fn() }
}

const RENDERER_URL = 'http://localhost:5173'

describe('createOrFocusDashboardPopout', () => {
  beforeEach(() => {
    instances.length = 0
    isMock.dev = false
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    getAllDisplaysMock.mockReturnValue([{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }])
  })

  afterEach(() => {
    // Reset the module-level singleton between tests.
    closeDashboardPopout()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('creates a native-frame window with the shared preload and no webview surface', () => {
    createOrFocusDashboardPopout(makeStore() as never)

    expect(instances).toHaveLength(1)
    const opts = instances[0].options
    expect(opts.title).toBe('Orca Agent Dashboard')
    expect(opts.minWidth).toBe(480)
    expect(opts.minHeight).toBe(360)
    // Native frame: neither a custom titleBarStyle nor frame:false is set.
    expect(opts.titleBarStyle).toBeUndefined()
    expect(opts.frame).toBeUndefined()
    expect(opts.backgroundColor).toBe('#0a0a0a') // dark theme mock
    expect(opts.webPreferences?.sandbox).toBe(true)
    expect(opts.webPreferences?.webviewTag).toBe(false)
    expect(opts.webPreferences?.preload).toMatch(/preload[\\/]index\.js$/)
    expect(installNavigationPolicyMock).toHaveBeenCalledWith(instances[0].webContents)
    expect(sendToTrustedUIRendererMock).toHaveBeenCalledWith('dashboard:popoutOpenChanged', true)
  })

  it('shows the window on ready-to-show', () => {
    createOrFocusDashboardPopout(makeStore() as never)
    const win = instances[0]
    expect(win.show).not.toHaveBeenCalled()
    win.emit('ready-to-show')
    expect(win.show).toHaveBeenCalledTimes(1)
  })

  it('loads the prod file entry with the requested view', () => {
    createOrFocusDashboardPopout(makeStore() as never, 'kanban')
    const win = instances[0]
    expect(win.loadURL).not.toHaveBeenCalled()
    expect(win.loadFile).toHaveBeenCalledTimes(1)
    const [file, options] = win.loadFile.mock.calls[0]
    expect(String(file)).toMatch(/renderer[\\/]popout\.html$/)
    expect(options).toEqual({ search: 'view=kanban' })
  })

  it('loads the dev server URL with the requested view when in dev', () => {
    isMock.dev = true
    vi.stubEnv('ELECTRON_RENDERER_URL', RENDERER_URL)
    createOrFocusDashboardPopout(makeStore() as never, 'kanban')
    const win = instances[0]
    expect(win.loadFile).not.toHaveBeenCalled()
    expect(win.loadURL).toHaveBeenCalledWith(`${RENDERER_URL}/popout.html?view=kanban`)
  })

  it('focuses the existing window instead of creating a second one', () => {
    const store = makeStore()
    const first = createOrFocusDashboardPopout(store as never)
    const second = createOrFocusDashboardPopout(store as never)
    expect(instances).toHaveLength(1)
    expect(second).toBe(first)
    expect(instances[0].focus).toHaveBeenCalledTimes(1)
  })

  it('trusts only the live popout webContents', () => {
    const win = createOrFocusDashboardPopout(makeStore() as never) as unknown as FakeWindow
    expect(isDashboardPopoutRenderer(win.webContents as never)).toBe(true)
    expect(isDashboardPopoutRenderer({ id: win.webContents.id } as never)).toBe(false)
    win.destroyed = true
    expect(isDashboardPopoutRenderer(win.webContents as never)).toBe(false)
  })

  it('restores a minimized window when re-requested', () => {
    const store = makeStore()
    const win = createOrFocusDashboardPopout(store as never) as unknown as FakeWindow
    win.minimized = true
    createOrFocusDashboardPopout(store as never)
    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('restores valid persisted bounds', () => {
    const store = makeStore({
      dashboardPopoutBounds: { x: 200, y: 150, width: 1000, height: 800 }
    })
    createOrFocusDashboardPopout(store as never)
    const opts = instances[0].options
    expect(opts.x).toBe(200)
    expect(opts.y).toBe(150)
    expect(opts.width).toBe(1000)
    expect(opts.height).toBe(800)
  })

  it('discards off-screen persisted bounds and falls back to defaults', () => {
    // Display does not overlap the saved rect at all.
    getAllDisplaysMock.mockReturnValue([{ workArea: { x: 0, y: 0, width: 800, height: 600 } }])
    const store = makeStore({
      dashboardPopoutBounds: { x: 5000, y: 5000, width: 1000, height: 800 }
    })
    createOrFocusDashboardPopout(store as never)
    const opts = instances[0].options
    expect(opts.x).toBeUndefined()
    expect(opts.y).toBeUndefined()
    expect(opts.width).toBe(960)
    expect(opts.height).toBe(720)
  })

  it('persists bounds on resize after the debounce, guarding near-minimum sizes', () => {
    vi.useFakeTimers()
    try {
      const store = makeStore()
      const win = createOrFocusDashboardPopout(store as never) as unknown as FakeWindow

      win.bounds = { x: 10, y: 10, width: 1200, height: 900 }
      win.emit('resize')
      vi.advanceTimersByTime(500)
      expect(store.updateUI).toHaveBeenCalledWith({
        dashboardPopoutBounds: { x: 10, y: 10, width: 1200, height: 900 }
      })

      store.updateUI.mockClear()
      win.bounds = { x: 10, y: 10, width: 100, height: 100 } // below minimum
      win.emit('resize')
      vi.advanceTimersByTime(500)
      expect(store.updateUI).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closeDashboardPopout closes an open window', () => {
    createOrFocusDashboardPopout(makeStore() as never)
    const win = instances[0]
    closeDashboardPopout()
    expect(win.close).toHaveBeenCalledTimes(1)
  })
})
