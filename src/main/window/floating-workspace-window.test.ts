import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { instances, FakeWindow, acquireMock, releaseMock, trustedRenderer, updateQuitMock } =
  vi.hoisted(() => {
    const created: InstanceType<typeof FakeWindowClass>[] = []

    class FakeWindowClass {
      options: Electron.BrowserWindowConstructorOptions
      private handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
      destroyed = false
      visible = false
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
      restore = vi.fn()
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
        return false
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

vi.mock('electron', () => ({
  app: { on: vi.fn(), removeListener: vi.fn(), isPackaged: true },
  BrowserWindow: FakeWindow,
  nativeTheme: { shouldUseDarkColors: true }
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
  onFloatingWorkspaceWindowEvent,
  showFloatingWorkspaceWindow,
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

describe('floating workspace window', () => {
  let events: FloatingWorkspaceWindowEvent[]
  let stopListening: () => void

  beforeEach(() => {
    instances.length = 0
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
})
