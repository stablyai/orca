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
    focused = false
    zoomLevel = 0
    private webContentsHandlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    webContents = {
      id: created.length + 1,
      send: vi.fn(),
      isDestroyed: () => this.destroyed,
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn()
      },
      on: (event: string, cb: (...args: unknown[]) => void) => {
        ;(this.webContentsHandlers[event] ||= []).push(cb)
      },
      setZoomLevel: vi.fn((level: number) => {
        this.zoomLevel = level
      }),
      getZoomLevel: vi.fn(() => this.zoomLevel)
    }
    emitWebContents(event: string, ...args: unknown[]): void {
      for (const cb of this.webContentsHandlers[event] ?? []) {
        cb(...args)
      }
    }
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
    isFocused(): boolean {
      return this.focused
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
  isDashboardPopoutRenderer,
  zoomDashboardPopoutIfFocused
} from './dashboard-popout-window'

type FakeWindow = InstanceType<typeof BrowserWindowMock>

function makeStore(ui: Record<string, unknown> = {}): {
  getUI: () => Record<string, unknown>
  updateUI: ReturnType<typeof vi.fn>
  onUIChanged: ReturnType<typeof vi.fn>
  emitUIChanged: (next: Record<string, unknown>) => void
  uiChangeUnsubscribe: ReturnType<typeof vi.fn>
} {
  const listeners: ((next: Record<string, unknown>) => void)[] = []
  const uiChangeUnsubscribe = vi.fn()
  return {
    getUI: () => ui,
    updateUI: vi.fn(),
    onUIChanged: vi.fn((listener: (next: Record<string, unknown>) => void) => {
      listeners.push(listener)
      return uiChangeUnsubscribe
    }),
    emitUIChanged: (next) => {
      for (const listener of listeners) {
        listener(next)
      }
    },
    uiChangeUnsubscribe
  }
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
    expect(opts.webPreferences?.partition).toBe('orca-dashboard-popout')
    expect(opts.webPreferences?.webviewTag).toBe(false)
    expect(opts.webPreferences?.preload).toMatch(/preload[\\/]index\.js$/)
    expect(installNavigationPolicyMock).toHaveBeenCalledWith(instances[0].webContents)
    const { session } = instances[0].webContents
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1)

    const permissionCallback = vi.fn()
    session.setPermissionRequestHandler.mock.calls[0][0](null, 'notifications', permissionCallback)
    expect(permissionCallback).toHaveBeenCalledWith(false)
    expect(session.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false)
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

  it('applies the persisted app zoom level on dom-ready', () => {
    const store = makeStore({ uiZoomLevel: 1.5 })
    const win = createOrFocusDashboardPopout(store as never) as unknown as FakeWindow
    expect(win.webContents.setZoomLevel).not.toHaveBeenCalled()
    win.emitWebContents('dom-ready')
    expect(win.webContents.setZoomLevel).toHaveBeenCalledWith(1.5)
  })

  it('follows app zoom changes while open and unsubscribes on close', () => {
    const store = makeStore({ uiZoomLevel: 0 })
    const win = createOrFocusDashboardPopout(store as never) as unknown as FakeWindow

    store.emitUIChanged({ uiZoomLevel: 2 })
    expect(win.webContents.setZoomLevel).toHaveBeenCalledWith(2)

    // Unchanged level: no redundant reapply that would clobber a local zoom.
    win.webContents.setZoomLevel.mockClear()
    store.emitUIChanged({ uiZoomLevel: 2 })
    expect(win.webContents.setZoomLevel).not.toHaveBeenCalled()

    win.emit('closed')
    expect(store.uiChangeUnsubscribe).toHaveBeenCalledTimes(1)
  })

  it('zoomDashboardPopoutIfFocused steps the popout zoom only while focused', () => {
    expect(zoomDashboardPopoutIfFocused('in')).toBe(false)

    const store = makeStore()
    const win = createOrFocusDashboardPopout(store as never) as unknown as FakeWindow
    expect(zoomDashboardPopoutIfFocused('in')).toBe(false)
    expect(win.zoomLevel).toBe(0)

    win.focused = true
    expect(zoomDashboardPopoutIfFocused('in')).toBe(true)
    expect(win.zoomLevel).toBe(0.5)
    expect(zoomDashboardPopoutIfFocused('out')).toBe(true)
    expect(win.zoomLevel).toBe(0)

    win.zoomLevel = 5
    expect(zoomDashboardPopoutIfFocused('in')).toBe(true)
    expect(win.zoomLevel).toBe(5) // clamped at max

    expect(zoomDashboardPopoutIfFocused('reset')).toBe(true)
    expect(win.zoomLevel).toBe(0)
  })

  it('handles the zoom-in chord via before-input-event and ignores other keys', () => {
    const store = makeStore()
    const win = createOrFocusDashboardPopout(store as never) as unknown as FakeWindow
    const mod =
      process.platform === 'darwin'
        ? { meta: true, control: false }
        : { meta: false, control: true }

    const zoomEvent = { preventDefault: vi.fn() }
    win.emitWebContents('before-input-event', zoomEvent, {
      type: 'keyDown',
      key: '=',
      code: 'Equal',
      alt: false,
      shift: false,
      ...mod
    })
    expect(zoomEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.zoomLevel).toBe(0.5)

    const plainKeyEvent = { preventDefault: vi.fn() }
    win.emitWebContents('before-input-event', plainKeyEvent, {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      alt: false,
      shift: false,
      meta: false,
      control: false
    })
    expect(plainKeyEvent.preventDefault).not.toHaveBeenCalled()
    expect(win.zoomLevel).toBe(0.5)
  })

  it('handles mouse-wheel zoom requests outside before-input-event', () => {
    const win = createOrFocusDashboardPopout(makeStore() as never) as unknown as FakeWindow
    const event = { preventDefault: vi.fn() }

    win.emitWebContents('zoom-changed', event, 'in')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.zoomLevel).toBe(0.5)

    win.emitWebContents('zoom-changed', event, 'out')
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    expect(win.zoomLevel).toBe(0)
  })

  it('respects zoom keybinding overrides for keyboard and mouse-wheel paths', () => {
    const win = createOrFocusDashboardPopout(makeStore() as never, undefined, {
      getKeybindings: () => ({
        'zoom.in': ['Mod+Y'],
        'zoom.out': []
      })
    }) as unknown as FakeWindow
    const mod =
      process.platform === 'darwin'
        ? { meta: true, control: false }
        : { meta: false, control: true }

    const defaultEvent = { preventDefault: vi.fn() }
    win.emitWebContents('before-input-event', defaultEvent, {
      type: 'keyDown',
      key: '=',
      code: 'Equal',
      alt: false,
      shift: false,
      ...mod
    })
    win.emitWebContents('zoom-changed', defaultEvent, 'out')
    expect(defaultEvent.preventDefault).not.toHaveBeenCalled()
    expect(win.zoomLevel).toBe(0)

    const customEvent = { preventDefault: vi.fn() }
    win.emitWebContents('before-input-event', customEvent, {
      type: 'keyDown',
      key: 'y',
      code: 'KeyY',
      alt: false,
      shift: false,
      ...mod
    })
    expect(customEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.zoomLevel).toBe(0.5)
  })
})
