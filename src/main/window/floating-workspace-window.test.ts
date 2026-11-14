import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { instances, FakeWindow, acquireMock, releaseMock, trustedRenderer, updateQuitMock } =
  vi.hoisted(() => {
    const created: InstanceType<typeof FakeWindowClass>[] = []

    class FakeWindowClass {
      options: Electron.BrowserWindowConstructorOptions
      private handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
      destroyed = false
      visible = false
      minimized = false
      bounds = { x: 0, y: 0, width: 960, height: 640 }
      setAlwaysOnTop = vi.fn()
      setVisibleOnAllWorkspaces = vi.fn()
      setBounds = vi.fn((next: { x: number; y: number; width: number; height: number }) => {
        this.bounds = next
      })
      webContents = {
        id: created.length + 1,
        send: vi.fn(),
        isDestroyed: () => this.destroyed,
        isCrashed: vi.fn(() => false),
        reload: vi.fn(),
        session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
        on: vi.fn()
      }
      show = vi.fn(() => {
        this.visible = true
      })
      showInactive = vi.fn(() => {
        this.visible = true
      })
      hide = vi.fn(() => {
        this.visible = false
      })
      focus = vi.fn()
      restore = vi.fn(() => {
        this.minimized = false
      })
      loadURL = vi.fn()
      loadFile = vi.fn()
      setTitle = vi.fn()
      destroy = vi.fn(() => {
        this.destroyed = true
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
        return this.on(event, cb)
      }
      emit(event: string, ...args: unknown[]): void {
        for (const cb of this.handlers[event] ?? []) {
          cb(...args)
        }
      }
      isDestroyed(): boolean {
        return this.destroyed
      }
      isVisible(): boolean {
        return this.visible
      }
      isFocused(): boolean {
        return false
      }
      isMinimized(): boolean {
        return this.minimized
      }
      getBounds(): { x: number; y: number; width: number; height: number } {
        return this.bounds
      }
      isFullScreen(): boolean {
        return false
      }
    }

    return {
      instances: created,
      FakeWindow: FakeWindowClass,
      acquireMock: vi.fn(),
      releaseMock: vi.fn(),
      trustedRenderer: { id: 900 },
      updateQuitMock: vi.fn(() => false)
    }
  })

const { cursorDisplay } = vi.hoisted(() => ({
  cursorDisplay: { workArea: { x: 0, y: 0, width: 1440, height: 875 } }
}))

vi.mock('electron', () => ({
  app: { on: vi.fn(), removeListener: vi.fn(), isPackaged: true },
  BrowserWindow: FakeWindow,
  nativeTheme: { shouldUseDarkColors: true },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => cursorDisplay
  }
}))
vi.mock('../ipc/ui', () => ({ getTrustedUIRendererWebContents: () => trustedRenderer }))
vi.mock('./security/privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: vi.fn()
}))
vi.mock('../updater/updater-service', () => ({ isQuittingForUpdate: updateQuitMock }))
vi.mock('./visibility/renderer-publication-throttle', () => ({
  rendererPublicationThrottle: { acquire: acquireMock }
}))

import {
  configureFloatingWorkspaceWindowLifecycle,
  destroyFloatingWorkspaceWindow,
  destroyFloatingWorkspaceWindowWithMainWindow,
  getFloatingWorkspaceWindow,
  isFloatingWorkspaceWindowRenderer,
  hideFloatingWorkspaceWindow,
  onFloatingWorkspaceWindowEvent,
  requestFloatingWorkspaceWindowPlacement,
  showFloatingWorkspaceWindow,
  summonFloatingWorkspaceWindow,
  type FloatingWorkspaceWindowEvent
} from './floating-workspace-window'

function showReady(): InstanceType<typeof FakeWindow> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the BrowserWindow surface the module uses.
  const window = showFloatingWorkspaceWindow(null, { focus: false }) as unknown as InstanceType<
    typeof FakeWindow
  >
  window.emit('ready-to-show')
  return window
}

function isRendererOf(window: InstanceType<typeof FakeWindow>): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture's webContents carries the identity the predicate compares.
  return isFloatingWorkspaceWindowRenderer(window.webContents as never)
}

function requestClose(window: InstanceType<typeof FakeWindow>): { preventDefault: () => void } {
  const event = { preventDefault: vi.fn() }
  window.emit('close', event)
  return event
}

const DEFAULT_WORK_AREA = { x: 0, y: 0, width: 1440, height: 875 }
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

describe('floating workspace window', () => {
  let events: FloatingWorkspaceWindowEvent[]
  let stopListening: () => void

  beforeEach(() => {
    instances.length = 0
    cursorDisplay.workArea = DEFAULT_WORK_AREA
    events = []
    releaseMock.mockReset()
    updateQuitMock.mockReset().mockReturnValue(false)
    acquireMock.mockReset().mockReturnValue(releaseMock)
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', undefined)
    vi.stubEnv('ORCA_E2E_HEADLESS', undefined)
    vi.stubEnv('ORCA_E2E_HEADFUL', undefined)
    configureFloatingWorkspaceWindowLifecycle({ getIsQuitting: () => false })
    stopListening = onFloatingWorkspaceWindowEvent((event) => events.push(event))
  })

  afterEach(() => {
    destroyFloatingWorkspaceWindow()
    stopListening()
    vi.unstubAllEnvs()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('a no-focus show on a foreground launch reveals the window inactive; a focused show activates it', () => {
    const window = showReady()
    expect(window.showInactive).toHaveBeenCalledTimes(1)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()

    showFloatingWorkspaceWindow(null, { focus: true })
    expect(window.focus).toHaveBeenCalledTimes(1)
    expect(window.show).not.toHaveBeenCalled()
  })

  it('a no-focus show in a windowless launch keeps the window hidden', () => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    const window = showReady()
    expect(window.showInactive).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.visible).toBe(false)
  })

  it('a user close while not quitting hides the window, keeps it and its renderer, and reports a user hide', () => {
    const window = showReady()
    showFloatingWorkspaceWindow(null, { focus: false })
    expect(acquireMock).toHaveBeenCalledTimes(1)
    expect(window.visible).toBe(true)

    const event = requestClose(window)

    expect(event.preventDefault).toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalledTimes(1)
    expect(window.destroy).not.toHaveBeenCalled()
    expect(getFloatingWorkspaceWindow()).toBe(window)
    expect(isRendererOf(window)).toBe(true)
    expect(events).toEqual(['user-hidden'])
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('while getIsQuitting() is true a close is prevented with no hide and no destroy; once it reads false a close hides', () => {
    let quitting = true
    configureFloatingWorkspaceWindowLifecycle({ getIsQuitting: () => quitting })
    const window = showReady()

    const event = requestClose(window)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
    expect(window.destroy).not.toHaveBeenCalled()
    expect(events).toEqual([])

    quitting = false
    requestClose(window)
    expect(window.hide).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['user-hidden'])
  })

  it('while an update install is quitting, a close neither hides nor reports a user hide', () => {
    const window = showReady()

    updateQuitMock.mockReturnValue(true)
    requestClose(window)

    expect(window.hide).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(releaseMock).not.toHaveBeenCalled()
  })

  it("the main window's closed event destroys the floating window", () => {
    configureFloatingWorkspaceWindowLifecycle({ getIsQuitting: () => true })
    const window = showReady()
    const mainWindow = new FakeWindow({})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the BrowserWindow surface the module uses.
    destroyFloatingWorkspaceWindowWithMainWindow(mainWindow as unknown as Electron.BrowserWindow)

    requestClose(window)
    expect(window.destroyed).toBe(false)

    mainWindow.emit('closed')

    expect(window.destroy).toHaveBeenCalledTimes(1)
    expect(window.isDestroyed()).toBe(true)
    expect(getFloatingWorkspaceWindow()).toBeNull()
    expect(isRendererOf(window)).toBe(false)
    expect(releaseMock).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['destroyed'])
  })

  it.each(['darwin', 'win32', 'linux'] as const)(
    'on %s it floats above other apps; only macOS gets a panel that cannot go full screen',
    (platform) => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      const window = showReady()
      expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
      expect(window.options.type).toBe(platform === 'darwin' ? 'panel' : undefined)
      expect(window.options.fullscreenable).toBe(platform === 'darwin' ? false : undefined)
      expect(window.setVisibleOnAllWorkspaces.mock.calls).toEqual(
        platform === 'win32'
          ? []
          : [[true, { visibleOnFullScreen: true, skipTransformProcessType: true }]]
      )
    }
  )

  it('the chord moves an open window that is off the cursor display there, size kept, and leaves one already there to the toggle', () => {
    const window = showReady()
    window.bounds = { x: 2000, y: 100, width: 960, height: 640 }
    expect(summonFloatingWorkspaceWindow()).toBe(true)
    expect(window.bounds).toEqual({ x: 240, y: 118, width: 960, height: 640 })
    expect(window.focus).toHaveBeenCalledTimes(1)

    // Body on this display, title bar above its work area: the window cannot be grabbed.
    window.bounds = { x: 100, y: -100, width: 960, height: 640 }
    expect(summonFloatingWorkspaceWindow()).toBe(true)
    expect(window.bounds).toEqual({ x: 240, y: 118, width: 960, height: 640 })

    expect(summonFloatingWorkspaceWindow()).toBe(false)
  })

  it('the chord restores a minimized open window, shows one the OS hid, and leaves a closed one to the toggle', () => {
    const window = showReady()
    window.minimized = true
    expect(summonFloatingWorkspaceWindow()).toBe(true)
    expect(window.restore).toHaveBeenCalledTimes(1)

    // Hidden outside main (Cmd+H on Orca) but still requested open.
    window.visible = false
    expect(summonFloatingWorkspaceWindow()).toBe(true)
    expect(window.visible).toBe(true)

    hideFloatingWorkspaceWindow()
    expect(summonFloatingWorkspaceWindow()).toBe(false)
  })

  it('a chord-requested show opens on the cursor display once; a hide drops an unused request', () => {
    cursorDisplay.workArea = { x: 1440, y: 0, width: 1920, height: 1055 }
    requestFloatingWorkspaceWindowPlacement()
    const window = showReady()
    expect(window.options).toMatchObject({ x: 1920, y: 208, width: 960, height: 640 })

    hideFloatingWorkspaceWindow()
    requestFloatingWorkspaceWindowPlacement()
    hideFloatingWorkspaceWindow()
    showFloatingWorkspaceWindow(null, { focus: false })
    expect(window.setBounds).not.toHaveBeenCalled()
  })
})
