/* oxlint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  browserWindowMock,
  openExternalMock,
  attachGuestPoliciesMock,
  buildFromTemplateMock,
  menuPopupMock,
  notificationMock,
  notificationShowMock,
  isMock
} = vi.hoisted(() => {
  const menuPopupMock = vi.fn()
  const notificationShowMock = vi.fn()
  return {
    browserWindowMock: vi.fn(),
    openExternalMock: vi.fn(),
    attachGuestPoliciesMock: vi.fn(),
    buildFromTemplateMock: vi.fn(() => ({ popup: menuPopupMock })),
    menuPopupMock,
    notificationMock: vi.fn(function () {
      return { show: notificationShowMock }
    }),
    notificationShowMock,
    isMock: { dev: false }
  }
})

vi.mock('electron', () => ({
  app: { on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: browserWindowMock,
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  Menu: { buildFromTemplate: buildFromTemplateMock },
  Notification: notificationMock,
  nativeTheme: { shouldUseDarkColors: false },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } })
  },
  shell: { openExternal: openExternalMock }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('../app-icon', () => ({
  getAppIconPath: vi.fn(() => 'icon')
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: {
    attachGuestPolicies: attachGuestPoliciesMock,
    setDictationShortcutForwardingPredicate: vi.fn()
  }
}))

import { createMainWindow, loadMainWindow } from './createMainWindow'
import { ipcMain } from 'electron'

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('createMainWindow', () => {
  beforeEach(() => {
    browserWindowMock.mockReset()
    openExternalMock.mockReset()
    attachGuestPoliciesMock.mockReset()
    buildFromTemplateMock.mockClear()
    menuPopupMock.mockClear()
    notificationMock.mockClear()
    notificationShowMock.mockClear()
    isMock.dev = false
    vi.mocked(ipcMain.on).mockReset()
    vi.mocked(ipcMain.removeListener).mockReset()
    vi.mocked(ipcMain.handle).mockReset()
    vi.mocked(ipcMain.removeHandler).mockReset()
    vi.useRealTimers()
  })

  it('can defer renderer loading until startup IPC handlers are registered', () => {
    const webContents = {
      on: vi.fn(),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    const win = createMainWindow(null, { deferLoad: true })

    expect(browserWindowInstance.loadFile).not.toHaveBeenCalled()
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    loadMainWindow(win)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()
  })

  it('enables renderer sandboxing and opens external links safely', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn((handler) => {
        windowHandlers.windowOpen = handler
      }),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    expect(browserWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({ sandbox: true })
      })
    )
    const browserWindowOptions = browserWindowMock.mock.calls[0]?.[0]
    // Why: macOS swallows the app-activating click unless the window accepts
    // first mouse, forcing a second click to focus the floating workspace.
    expect(browserWindowOptions.acceptFirstMouse).toBe(true)
    if (process.platform === 'darwin') {
      expect(browserWindowOptions).toMatchObject({
        titleBarStyle: 'hiddenInset'
      })
    } else if (process.platform === 'win32') {
      expect(browserWindowOptions).toMatchObject({
        titleBarStyle: 'hidden'
      })
    } else {
      // Linux: native frame is dropped so the renderer titlebar isn't stacked
      // under the WM title bar (double title bar). titleBarStyle stays unset.
      expect(browserWindowOptions.titleBarStyle).toBeUndefined()
      expect(browserWindowOptions.frame).toBe(false)
    }

    expect(windowHandlers.windowOpen({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(windowHandlers.windowOpen({ url: 'localhost:3000' })).toEqual({ action: 'deny' })
    expect(windowHandlers.windowOpen({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(windowHandlers.windowOpen({ url: 'not a url' })).toEqual({ action: 'deny' })

    expect(openExternalMock).toHaveBeenCalledTimes(2)
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/')
    expect(openExternalMock).toHaveBeenCalledWith('http://localhost:3000/')

    const preventDefault = vi.fn()
    windowHandlers['will-navigate']({ preventDefault } as never, 'https://example.com/docs')
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledTimes(3)
    expect(openExternalMock).toHaveBeenLastCalledWith('https://example.com/docs')

    const localhostPreventDefault = vi.fn()
    windowHandlers['will-navigate'](
      { preventDefault: localhostPreventDefault } as never,
      'localhost:3000'
    )
    expect(localhostPreventDefault).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledTimes(4)
    expect(openExternalMock).toHaveBeenLastCalledWith('http://localhost:3000/')

    const fileNavigationPreventDefault = vi.fn()
    windowHandlers['will-navigate'](
      { preventDefault: fileNavigationPreventDefault } as never,
      'file:///etc/passwd'
    )
    expect(fileNavigationPreventDefault).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledTimes(4)

    const allowBlankEvent = { preventDefault: vi.fn() }
    const allowBlankPrefs = { partition: 'persist:orca-browser' }
    windowHandlers['will-attach-webview'](
      allowBlankEvent as never,
      allowBlankPrefs as never,
      { src: 'data:text/html,' } as never
    )
    expect(allowBlankEvent.preventDefault).not.toHaveBeenCalled()
    expect(allowBlankPrefs).toMatchObject({
      disableHtmlFullscreenWindowResize: true,
      partition: 'persist:orca-browser',
      sandbox: true
    })

    const denyInlineHtmlEvent = { preventDefault: vi.fn() }
    windowHandlers['will-attach-webview'](
      denyInlineHtmlEvent as never,
      { partition: 'persist:orca-browser' } as never,
      { src: 'data:text/html,<script>alert(1)</script>' } as never
    )
    expect(denyInlineHtmlEvent.preventDefault).toHaveBeenCalledTimes(1)

    const guest = { marker: 'guest' }
    windowHandlers['did-attach-webview']({} as never, guest as never)
    expect(attachGuestPoliciesMock).toHaveBeenCalledWith(guest)
  })

  it('sets platform-specific titlebar and frame options for every desktop platform', () => {
    for (const [platform, expected] of [
      ['darwin', { titleBarStyle: 'hiddenInset', frame: undefined }],
      ['win32', { titleBarStyle: 'hidden', frame: undefined }],
      ['linux', { titleBarStyle: undefined, frame: false }]
    ] satisfies [
      NodeJS.Platform,
      { titleBarStyle: string | undefined; frame: boolean | undefined }
    ][]) {
      browserWindowMock.mockReset()
      const webContents = {
        on: vi.fn(),
        setZoomLevel: vi.fn(),
        setBackgroundThrottling: vi.fn(),
        invalidate: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        send: vi.fn(),
        isDevToolsOpened: vi.fn(),
        openDevTools: vi.fn(),
        closeDevTools: vi.fn()
      }
      const browserWindowInstance = {
        webContents,
        on: vi.fn(),
        isDestroyed: vi.fn(() => false),
        isMaximized: vi.fn(() => true),
        isFullScreen: vi.fn(() => false),
        getSize: vi.fn(() => [1200, 800]),
        setSize: vi.fn(),
        setWindowButtonPosition: vi.fn(),
        maximize: vi.fn(),
        show: vi.fn(),
        loadFile: vi.fn(),
        loadURL: vi.fn()
      }
      browserWindowMock.mockImplementation(function () {
        return browserWindowInstance
      })

      withPlatform(platform, () => createMainWindow(null))

      const browserWindowOptions = browserWindowMock.mock.calls[0]?.[0]
      expect(browserWindowOptions.titleBarStyle).toBe(expected.titleBarStyle)
      expect(browserWindowOptions.frame).toBe(expected.frame)
    }
  })

  it('supports all minus key variants for terminal zoom out', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const beforeInputEvent = windowHandlers['before-input-event']

    const primary =
      process.platform === 'darwin'
        ? { control: false, meta: true }
        : { control: true, meta: false }

    for (const input of [
      { type: 'keyDown', ...primary, alt: false, key: '-' },
      { type: 'keyDown', ...primary, alt: false, key: 'Minus' },
      { type: 'keyDown', ...primary, alt: false, key: 'Subtract' },
      { type: 'keyDown', ...primary, alt: false, key: '', code: 'Minus' },
      { type: 'keyDown', ...primary, alt: false, key: '', code: 'NumpadSubtract' }
    ]) {
      const preventDefault = vi.fn()
      beforeInputEvent({ preventDefault } as never, input as never)
      expect(preventDefault).toHaveBeenCalledTimes(1)
    }

    expect(webContents.send).toHaveBeenCalledTimes(5)
    expect(webContents.send).toHaveBeenNthCalledWith(1, 'terminal:zoom', 'out')
    expect(webContents.send).toHaveBeenNthCalledWith(2, 'terminal:zoom', 'out')
    expect(webContents.send).toHaveBeenNthCalledWith(3, 'terminal:zoom', 'out')
    expect(webContents.send).toHaveBeenNthCalledWith(4, 'terminal:zoom', 'out')
    expect(webContents.send).toHaveBeenNthCalledWith(5, 'terminal:zoom', 'out')

    const undoPreventDefault = vi.fn()
    beforeInputEvent(
      { preventDefault: undoPreventDefault } as never,
      { type: 'keyDown', ...primary, alt: false, shift: true, key: '_' } as never
    )
    expect(undoPreventDefault).not.toHaveBeenCalled()
  })

  it('routes Electron zoom command events to terminal zoom', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const onZoomChanged = windowHandlers['zoom-changed']
    const preventDefault = vi.fn()
    onZoomChanged({ preventDefault } as never, 'out')
    onZoomChanged({ preventDefault } as never, 'in')

    expect(preventDefault).toHaveBeenCalledTimes(2)
    expect(webContents.send).toHaveBeenCalledTimes(2)
    expect(webContents.send).toHaveBeenNthCalledWith(1, 'terminal:zoom', 'out')
    expect(webContents.send).toHaveBeenNthCalledWith(2, 'terminal:zoom', 'in')
  })

  it('respects custom zoom bindings for Electron zoom command fallbacks', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null, {
      getKeybindings: () => ({
        'zoom.in': ['Mod+Y'],
        'zoom.out': []
      })
    })

    const onZoomChanged = windowHandlers['zoom-changed']
    const preventDefault = vi.fn()
    onZoomChanged({ preventDefault } as never, 'out')
    onZoomChanged({ preventDefault } as never, 'in')

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalled()
  })

  it('does not intercept ctrl/cmd+r in before-input-event', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    for (const input of [
      { type: 'keyDown', code: 'KeyR', key: 'r', meta: false, control: true, alt: false },
      { type: 'keyDown', code: 'KeyR', key: 'r', meta: true, control: false, alt: false }
    ]) {
      const preventDefault = vi.fn()
      windowHandlers['before-input-event']({ preventDefault } as never, input as never)
      expect(preventDefault).not.toHaveBeenCalled()
    }

    expect(webContents.send).not.toHaveBeenCalled()
  })

  it('forwards the platform tab-number jump shortcut to the renderer', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const input =
      process.platform === 'darwin'
        ? { type: 'keyDown', code: 'Digit5', key: '5', meta: false, control: true, alt: false }
        : { type: 'keyDown', code: 'Digit5', key: '5', meta: false, control: false, alt: true }
    const preventDefault = vi.fn()
    windowHandlers['before-input-event']({ preventDefault } as never, input as never)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:jumpToTabIndex', 4)
  })

  it('lets main-window Ctrl+Tab flow to the renderer held switcher', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const beforeInputEvent = windowHandlers['before-input-event']
    const dispatchInput = (input: Electron.Input): ReturnType<typeof vi.fn> => {
      const preventDefault = vi.fn()
      beforeInputEvent({ preventDefault } as never, input as never)
      return preventDefault
    }
    const ctrlTabInput = {
      code: 'Tab',
      key: 'Tab',
      control: true,
      meta: false,
      alt: false
    }
    const preventDefaults = [
      { type: 'keyDown', shift: false },
      { type: 'keyDown', shift: true },
      { type: 'keyUp', shift: true },
      { type: 'keyUp', code: 'ControlLeft', key: 'Control', control: false, shift: false }
    ].map((input) => dispatchInput({ ...ctrlTabInput, ...input } as Electron.Input))

    for (const preventDefault of preventDefaults) {
      expect(preventDefault).not.toHaveBeenCalled()
    }
    expect(webContents.send).not.toHaveBeenCalledWith('ui:ctrlTabKeyDown', expect.anything())
    expect(webContents.send).not.toHaveBeenCalledWith('ui:ctrlTabKeyUp')
  })

  it('does not hardcode Ctrl+Tab when the recent-tab binding is disabled', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null, { getKeybindings: () => ({ 'tab.previousRecent': [] }) })

    const preventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault } as never,
      {
        type: 'keyDown',
        code: 'Tab',
        key: 'Tab',
        control: true,
        meta: false,
        alt: false,
        shift: false
      } as never
    )

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:ctrlTabKeyDown', expect.anything())
    expect(webContents.send).not.toHaveBeenCalledWith('ui:switchRecentTab')
  })

  it('only intercepts the dictation chord when enabled toggle mode can handle it', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    const voice: { enabled: boolean; sttModel: string; dictationMode: 'toggle' | 'hold' } = {
      enabled: false,
      sttModel: '',
      dictationMode: 'toggle'
    }
    createMainWindow({
      getUI: () => ({}) as never,
      getSettings: () => ({ windowBackgroundBlur: false, voice }) as never,
      updateUI: vi.fn()
    } as never)

    const isDarwin = process.platform === 'darwin'
    const dictationInput = {
      type: 'keyDown',
      code: 'KeyE',
      key: 'e',
      meta: isDarwin,
      control: !isDarwin,
      alt: false,
      shift: false
    }

    const disabledPreventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault: disabledPreventDefault } as never,
      dictationInput as never
    )
    expect(disabledPreventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:dictationKeyDown')

    voice.enabled = true
    voice.sttModel = 'test-model'
    voice.dictationMode = 'hold'
    const holdPreventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault: holdPreventDefault } as never,
      dictationInput as never
    )
    expect(holdPreventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:dictationKeyDown')

    voice.dictationMode = 'toggle'
    const togglePreventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault: togglePreventDefault } as never,
      dictationInput as never
    )
    expect(togglePreventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:dictationKeyDown')

    webContents.send.mockClear()
    const repeatPreventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault: repeatPreventDefault } as never,
      { ...dictationInput, isAutoRepeat: true } as never
    )
    expect(repeatPreventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).not.toHaveBeenCalled()
  })

  it('only intercepts double-tap dictation when enabled toggle mode can handle it', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    const voice: { enabled: boolean; sttModel: string; dictationMode: 'toggle' | 'hold' } = {
      enabled: false,
      sttModel: '',
      dictationMode: 'toggle'
    }
    createMainWindow(
      {
        getUI: () => ({}),
        getSettings: () => ({ windowBackgroundBlur: false, voice }) as never,
        updateUI: vi.fn()
      } as never,
      {
        getKeybindings: () => ({ 'voice.dictation': ['DoubleTap+Shift'] })
      }
    )

    const triggerDoubleTapShift = (): ReturnType<typeof vi.fn> => {
      const modifierInput = {
        code: 'ShiftLeft',
        key: 'Shift',
        shift: true,
        meta: false,
        control: false,
        alt: false
      }
      windowHandlers['before-input-event'](
        { preventDefault: vi.fn() } as never,
        { ...modifierInput, type: 'keyDown' } as never
      )
      windowHandlers['before-input-event'](
        { preventDefault: vi.fn() } as never,
        { ...modifierInput, type: 'keyUp' } as never
      )
      const preventDefault = vi.fn()
      windowHandlers['before-input-event'](
        { preventDefault } as never,
        { ...modifierInput, type: 'keyDown' } as never
      )
      windowHandlers['before-input-event'](
        { preventDefault: vi.fn() } as never,
        { ...modifierInput, type: 'keyUp' } as never
      )
      return preventDefault
    }

    const disabledPreventDefault = triggerDoubleTapShift()
    expect(disabledPreventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:dictationKeyDown')

    voice.enabled = true
    voice.sttModel = 'test-model'
    voice.dictationMode = 'hold'
    const holdPreventDefault = triggerDoubleTapShift()
    expect(holdPreventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:dictationKeyDown')

    voice.dictationMode = 'toggle'
    const togglePreventDefault = triggerDoubleTapShift()
    expect(togglePreventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:dictationKeyDown')
  })

  it('forwards ctrl/cmd+j to the worktree palette toggle event', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const isDarwin = process.platform === 'darwin'
    for (const input of [
      {
        type: 'keyDown',
        code: 'KeyJ',
        key: 'j',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: !isDarwin
      },
      {
        type: 'keyDown',
        code: 'KeyJ',
        key: '',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: !isDarwin
      }
    ]) {
      const preventDefault = vi.fn()
      windowHandlers['before-input-event']({ preventDefault } as never, input as never)
      expect(preventDefault).toHaveBeenCalledTimes(1)
    }

    expect(webContents.send).toHaveBeenCalledTimes(2)
    expect(webContents.send).toHaveBeenNthCalledWith(1, 'ui:toggleWorktreePalette')
    expect(webContents.send).toHaveBeenNthCalledWith(2, 'ui:toggleWorktreePalette')
  })

  it('lets Terminal-first pass risky app shortcuts through when terminal input is focused', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow({
      getUI: () => ({}),
      getSettings: () => ({ terminalShortcutPolicy: 'terminal-first' })
    } as never)

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setTerminalInputFocused')?.[1]
    expect(setFocusedListener).toBeTypeOf('function')
    setFocusedListener?.({ sender: webContents } as never, true)

    const preventDefault = vi.fn()
    const isDarwin = process.platform === 'darwin'
    windowHandlers['before-input-event'](
      { preventDefault } as never,
      {
        type: 'keyDown',
        code: 'KeyJ',
        key: 'j',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: !isDarwin
      } as never
    )

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalled()
  })

  it('allows double-tap shortcuts while terminal input is focused with Terminal-first policy', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(
      {
        getUI: () => ({}),
        getSettings: () => ({ terminalShortcutPolicy: 'terminal-first' })
      } as never,
      {
        getKeybindings: () => ({ 'worktree.quickOpen': ['DoubleTap+Shift'] })
      }
    )

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setTerminalInputFocused')?.[1]
    expect(setFocusedListener).toBeTypeOf('function')
    setFocusedListener?.({ sender: webContents } as never, true)

    const modifierInput = {
      code: 'ShiftLeft',
      key: 'Shift',
      shift: true,
      meta: false,
      control: false,
      alt: false
    }
    const firstDownPreventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault: firstDownPreventDefault } as never,
      { ...modifierInput, type: 'keyDown' } as never
    )
    const firstUpPreventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault: firstUpPreventDefault } as never,
      { ...modifierInput, type: 'keyUp' } as never
    )
    const secondDownPreventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault: secondDownPreventDefault } as never,
      { ...modifierInput, type: 'keyDown' } as never
    )

    expect(firstDownPreventDefault).not.toHaveBeenCalled()
    expect(firstUpPreventDefault).not.toHaveBeenCalled()
    expect(secondDownPreventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:openQuickOpen')
  })

  it('notifies before Orca-first captures a risky terminal-focused shortcut', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow({
      getUI: () => ({}),
      getSettings: () => ({ terminalShortcutPolicy: 'orca-first' })
    } as never)

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setTerminalInputFocused')?.[1]
    expect(setFocusedListener).toBeTypeOf('function')
    setFocusedListener?.({ sender: webContents } as never, true)

    const preventDefault = vi.fn()
    const isDarwin = process.platform === 'darwin'
    windowHandlers['before-input-event'](
      { preventDefault } as never,
      {
        type: 'keyDown',
        code: 'KeyJ',
        key: 'j',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: !isDarwin
      } as never
    )

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenNthCalledWith(1, 'ui:terminalShortcutCaptured', {
      actionId: 'worktree.palette'
    })
    expect(webContents.send).toHaveBeenNthCalledWith(2, 'ui:toggleWorktreePalette')
  })

  it('notifies before Orca-first captures a terminal-focused double-tap shortcut', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(
      {
        getUI: () => ({}),
        getSettings: () => ({ terminalShortcutPolicy: 'orca-first' })
      } as never,
      {
        getKeybindings: () => ({ 'worktree.quickOpen': ['DoubleTap+Shift'] })
      }
    )

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setTerminalInputFocused')?.[1]
    expect(setFocusedListener).toBeTypeOf('function')
    setFocusedListener?.({ sender: webContents } as never, true)

    const modifierInput = {
      code: 'ShiftLeft',
      key: 'Shift',
      shift: true,
      meta: false,
      control: false,
      alt: false
    }
    windowHandlers['before-input-event'](
      { preventDefault: vi.fn() } as never,
      { ...modifierInput, type: 'keyDown' } as never
    )
    windowHandlers['before-input-event'](
      { preventDefault: vi.fn() } as never,
      { ...modifierInput, type: 'keyUp' } as never
    )
    const preventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault } as never,
      { ...modifierInput, type: 'keyDown' } as never
    )

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenNthCalledWith(1, 'ui:terminalShortcutCaptured', {
      actionId: 'worktree.quickOpen'
    })
    expect(webContents.send).toHaveBeenNthCalledWith(2, 'ui:openQuickOpen')
  })

  it('forwards the configured workspace delete shortcut while terminal input is focused', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(
      {
        getUI: () => ({}),
        getSettings: () => ({ terminalShortcutPolicy: 'terminal-first' })
      } as never,
      {
        getKeybindings: () => ({ 'workspace.delete': ['Mod+Shift+Backspace'] })
      }
    )

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setTerminalInputFocused')?.[1]
    expect(setFocusedListener).toBeTypeOf('function')
    setFocusedListener?.({ sender: webContents } as never, true)

    const isDarwin = process.platform === 'darwin'
    const preventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault } as never,
      {
        type: 'keyDown',
        code: 'Backspace',
        key: 'Backspace',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: true
      } as never
    )

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:deleteCurrentWorkspace')
  })

  it('toggles devtools on F12 in development', () => {
    isMock.dev = true

    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(() => false),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const preventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault } as never,
      { type: 'keyDown', code: 'F12', key: 'F12', meta: false, control: false, alt: false } as never
    )

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.openDevTools).toHaveBeenCalledWith({ mode: 'undocked' })
    expect(webContents.closeDevTools).not.toHaveBeenCalled()
  })

  it('clears the quit latch when the renderer prevents unload', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    const onQuitAborted = vi.fn()
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null, { getIsQuitting: () => true, onQuitAborted })

    const preventDefault = vi.fn()
    windowHandlers.close({ preventDefault } as never)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('window:close-requested', { isQuitting: true })

    windowHandlers['will-prevent-unload']()
    expect(onQuitAborted).toHaveBeenCalledTimes(1)
  })

  it('allows close after the renderer process is gone', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => false)
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null, { getIsQuitting: () => true })

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as never
    )
    const preventDefault = vi.fn()
    windowHandlers.close({ preventDefault } as never)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('window:close-requested', {
      isQuitting: true
    })

    consoleError.mockRestore()
  })

  it('does not notify the crash recorder when renderer teardown follows a confirmed window close', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const ipcHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => false)
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn(),
      close: vi.fn(() => {
        windowHandlers.close({} as never)
      })
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
      ipcHandlers[channel] = handler as (...args: any[]) => void
      return ipcMain
    })
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })
    const onRendererProcessGone = vi.fn()

    createMainWindow(null, { onRendererProcessGone })

    ipcHandlers['window:confirm-close']?.()
    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'killed',
        exitCode: 9
      } as never
    )

    expect(onRendererProcessGone).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('does not persist pending bounds after bypassing close for a gone renderer', () => {
    vi.useFakeTimers()

    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => false)
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      getBounds: vi.fn(() => ({ x: 10, y: 20, width: 1000, height: 700 })),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    const updateUI = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow({
      getUI: () => ({}),
      getSettings: () => ({ windowBackgroundBlur: false }),
      updateUI
    } as never)

    windowHandlers.resize()
    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as never
    )
    const preventDefault = vi.fn()
    windowHandlers.close({ preventDefault } as never)
    vi.advanceTimersByTime(500)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(updateUI).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('resumes close confirmation after a renderer process reloads', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => false)
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null, { getIsQuitting: () => true })

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as never
    )
    windowHandlers['did-finish-load']?.()
    const preventDefault = vi.fn()
    windowHandlers.close({ preventDefault } as never)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
      isQuitting: true
    })

    consoleError.mockRestore()
  })

  it('allows close when Electron reports a crashed webContents', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => true)
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null, { getIsQuitting: () => true })

    const preventDefault = vi.fn()
    windowHandlers.close({ preventDefault } as never)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('window:close-requested', {
      isQuitting: true
    })
  })

  it('ignores traffic light sync IPC on non-macOS', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      setWindowButtonPosition: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const syncListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:sync-traffic-lights')?.[1]

    expect(syncListener).toBeTypeOf('function')

    syncListener?.({} as never, 1.2)

    if (process.platform === 'darwin') {
      expect(browserWindowInstance.setWindowButtonPosition).toHaveBeenCalledWith({ x: 16, y: 16 })
      return
    }

    expect(browserWindowInstance.setWindowButtonPosition).not.toHaveBeenCalled()
  })

  it('intercepts Cmd+B for sidebar when the markdown editor is not focused', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const preventDefault = vi.fn()
    const isDarwin = process.platform === 'darwin'
    windowHandlers['before-input-event'](
      { preventDefault } as never,
      {
        type: 'keyDown',
        code: 'KeyB',
        key: 'b',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      } as never
    )

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:toggleLeftSidebar')
  })

  it('skips Cmd+B interception when the markdown editor is focused', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setMarkdownEditorFocused')?.[1]
    expect(setFocusedListener).toBeTypeOf('function')
    setFocusedListener?.({ sender: webContents } as never, true)

    const preventDefault = vi.fn()
    const isDarwin = process.platform === 'darwin'
    windowHandlers['before-input-event'](
      { preventDefault } as never,
      {
        type: 'keyDown',
        code: 'KeyB',
        key: 'b',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      } as never
    )

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:toggleLeftSidebar')
  })

  it('lets the shortcut recorder capture app shortcuts before main interception', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setShortcutRecorderFocused')?.[1]
    expect(setFocusedListener).toBeTypeOf('function')
    setFocusedListener?.({ sender: webContents } as never, true)

    const preventDefault = vi.fn()
    const isDarwin = process.platform === 'darwin'
    windowHandlers['before-input-event'](
      { preventDefault } as never,
      {
        type: 'keyDown',
        code: 'KeyB',
        key: 'b',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      } as never
    )

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:toggleLeftSidebar')
  })

  it('skips Cmd+B interception when floating terminal input is focused', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setFloatingTerminalInputFocused')?.[1]
    expect(setFocusedListener).toBeTypeOf('function')
    setFocusedListener?.({ sender: webContents } as never, true)

    const preventDefault = vi.fn()
    const isDarwin = process.platform === 'darwin'
    windowHandlers['before-input-event'](
      { preventDefault } as never,
      {
        type: 'keyDown',
        code: 'KeyB',
        key: 'b',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      } as never
    )

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:toggleLeftSidebar')

    webContents.send.mockClear()
    const newWorkspacePreventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault: newWorkspacePreventDefault } as never,
      {
        type: 'keyDown',
        code: 'KeyN',
        key: 'n',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      } as never
    )

    expect(newWorkspacePreventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:openNewWorkspace')
  })

  it('still intercepts Cmd+Shift+B and Cmd+Alt+B when the markdown editor is focused', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setMarkdownEditorFocused')?.[1]
    setFocusedListener?.({ sender: webContents } as never, true)

    const isDarwin = process.platform === 'darwin'

    // Cmd+Shift+B is not in the policy allowlist, so no action resolves and no
    // preventDefault fires — but the carve-out must not be what lets it through.
    const shiftPreventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault: shiftPreventDefault } as never,
      {
        type: 'keyDown',
        code: 'KeyB',
        key: 'B',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: true
      } as never
    )
    expect(shiftPreventDefault).not.toHaveBeenCalled()

    // Cmd+Alt+B is not a modifier chord in the policy (alt excluded), so the
    // policy returns null and no preventDefault fires. Assert the carve-out
    // is not what's short-circuiting this — it requires !alt.
    const altPreventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault: altPreventDefault } as never,
      {
        type: 'keyDown',
        code: 'KeyB',
        key: 'b',
        meta: isDarwin,
        control: !isDarwin,
        alt: true,
        shift: false
      } as never
    )
    expect(altPreventDefault).not.toHaveBeenCalled()
  })

  it('coerces non-boolean setMarkdownEditorFocused payloads to false', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setMarkdownEditorFocused')?.[1]

    // Seed to true with a legitimate payload, then send a non-boolean and
    // assert the flag returns to false by checking Cmd+B resumes interception.
    setFocusedListener?.({ sender: webContents } as never, true)
    setFocusedListener?.({ sender: webContents } as never, { malicious: true } as never)

    const preventDefault = vi.fn()
    const isDarwin = process.platform === 'darwin'
    windowHandlers['before-input-event'](
      { preventDefault } as never,
      {
        type: 'keyDown',
        code: 'KeyB',
        key: 'b',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      } as never
    )

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:toggleLeftSidebar')
  })

  it('shows spellcheck context menu for editable text without relying on markdown focus mirror', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn(),
      replaceMisspelling: vi.fn(),
      session: { addWordToSpellCheckerDictionary: vi.fn() }
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    windowHandlers['context-menu'](
      {} as never,
      {
        x: 42,
        y: 84,
        isEditable: true,
        spellcheckEnabled: true,
        dictionarySuggestions: ['reference'],
        misspelledWord: 'refrence'
      } as Electron.ContextMenuParams
    )

    expect(buildFromTemplateMock).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ label: 'reference' })])
    )
    expect(menuPopupMock).toHaveBeenCalledWith({ window: browserWindowInstance, x: 42, y: 84 })
  })

  it('does not read destroyed webContents during closed cleanup', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn(),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    let webContentsDestroyed = false
    const browserWindowInstance = {
      get webContents() {
        if (webContentsDestroyed) {
          throw new Error('Object has been destroyed')
        }
        return webContents
      },
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    webContentsDestroyed = true

    // Why: Electron may destroy webContents before BrowserWindow's `closed`
    // cleanup runs during updater shutdown. The cleanup must not crash, or
    // Squirrel.Mac never reaches the relaunch step.
    expect(() => windowHandlers.closed?.()).not.toThrow()
  })

  it('resets the markdown editor focus flag on renderer crash, navigation, and destroy', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setMarkdownEditorFocused')?.[1]
    const isDarwin = process.platform === 'darwin'

    const cmdBInput = {
      type: 'keyDown',
      code: 'KeyB',
      key: 'b',
      meta: isDarwin,
      control: !isDarwin,
      alt: false,
      shift: false
    } as never

    const assertInterceptsAfterReset = (): void => {
      webContents.send.mockClear()
      const preventDefault = vi.fn()
      windowHandlers['before-input-event']({ preventDefault } as never, cmdBInput)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(webContents.send).toHaveBeenCalledWith('ui:toggleLeftSidebar')
    }

    // render-process-gone
    setFocusedListener?.({ sender: webContents } as never, true)
    windowHandlers['render-process-gone']?.()
    assertInterceptsAfterReset()

    // did-start-navigation (main frame)
    setFocusedListener?.({ sender: webContents } as never, true)
    windowHandlers['did-start-navigation']?.({} as never, 'https://example.com/', false, true)
    assertInterceptsAfterReset()

    // did-start-navigation (sub-frame) should NOT reset the flag
    setFocusedListener?.({ sender: webContents } as never, true)
    windowHandlers['did-start-navigation']?.({} as never, 'https://example.com/', false, false)
    webContents.send.mockClear()
    const subframePreventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault: subframePreventDefault } as never,
      cmdBInput
    )
    expect(subframePreventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:toggleLeftSidebar')

    // destroyed
    setFocusedListener?.({ sender: webContents } as never, true)
    windowHandlers['destroyed']?.()
    assertInterceptsAfterReset()
  })

  it('notifies the caller when the renderer process is gone', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      id: 142,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })
    const onRendererProcessGone = vi.fn()

    createMainWindow(null, { onRendererProcessGone })

    const details = { reason: 'crashed', exitCode: 5 } as Electron.RenderProcessGoneDetails
    windowHandlers['render-process-gone']?.({} as never, details)

    expect(onRendererProcessGone).toHaveBeenCalledWith(details, 142)
  })

  it('passes the renderer webContents id through crash classification callbacks', () => {
    vi.useFakeTimers()

    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      id: 424,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })
    const onRendererProcessGone = vi.fn()
    const shouldRecordRendererCrash = vi.fn(() => true)
    const shouldRecoverRenderer = vi.fn(() => true)

    try {
      createMainWindow(null, {
        onRendererProcessGone,
        shouldRecordRendererCrash,
        shouldRecoverRenderer
      })

      const details = { reason: 'crashed', exitCode: 5 } as Electron.RenderProcessGoneDetails
      windowHandlers['render-process-gone']?.({} as never, details)
      vi.advanceTimersByTime(250)

      expect(shouldRecordRendererCrash).toHaveBeenCalledWith(details, 424)
      expect(onRendererProcessGone).toHaveBeenCalledWith(details, 424)
      expect(shouldRecoverRenderer).toHaveBeenCalledWith(details, 424)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('does not notify the crash recorder for an expected renderer teardown', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })
    const onRendererProcessGone = vi.fn()

    createMainWindow(null, {
      onRendererProcessGone,
      shouldRecordRendererCrash: () => false
    })

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'killed',
        exitCode: 15
      } as Electron.RenderProcessGoneDetails
    )

    expect(onRendererProcessGone).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  const createRendererRecoveryWindowHarness = () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      id: 143,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    return { browserWindowInstance, windowHandlers }
  }

  it('reloads the app shell after an unexpected renderer process loss', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    createMainWindow(null)

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as Electron.RenderProcessGoneDetails
    )
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(250)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('does not reload after renderer loss when recovery is disabled', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    createMainWindow(null, { shouldRecoverRenderer: () => false })

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as Electron.RenderProcessGoneDetails
    )
    vi.advanceTimersByTime(250)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('rechecks the renderer recovery predicate before reloading', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()
    let shouldRecover = true

    createMainWindow(null, { shouldRecoverRenderer: () => shouldRecover })

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as Electron.RenderProcessGoneDetails
    )
    shouldRecover = false
    vi.advanceTimersByTime(250)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('coalesces repeated renderer losses into one recovery reload', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    createMainWindow(null)

    const details = {
      reason: 'crashed',
      exitCode: 5
    } as Electron.RenderProcessGoneDetails
    windowHandlers['render-process-gone']?.({} as never, details)
    windowHandlers['render-process-gone']?.({} as never, details)
    vi.advanceTimersByTime(250)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('does not reload after a clean renderer exit', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    createMainWindow(null)

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'clean-exit',
        exitCode: 0
      } as Electron.RenderProcessGoneDetails
    )
    vi.advanceTimersByTime(250)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('cancels renderer recovery when the crashed window is closing', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    createMainWindow(null)

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as Electron.RenderProcessGoneDetails
    )
    windowHandlers.close({ preventDefault: vi.fn() } as never)
    vi.advanceTimersByTime(250)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('stops auto-reloading after a rapid renderer crash loop trips the breaker', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    createMainWindow(null, { onRendererRecoveryExhausted })

    const details = { reason: 'crashed', exitCode: 5 } as Electron.RenderProcessGoneDetails
    // Each cycle: renderer dies, breaker allows the first 3 reloads, then opens.
    const driveCrashCycle = (): void => {
      windowHandlers['render-process-gone']?.({} as never, details)
      vi.advanceTimersByTime(250)
    }
    driveCrashCycle()
    driveCrashCycle()
    driveCrashCycle()
    // 1 initial load + 3 recoveries.
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(4)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    // 4th crash within the window: breaker is open, no further reload.
    driveCrashCycle()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(4)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ recentRecoveryCount: 3 })
    )

    consoleError.mockRestore()
  })

  function createStartupRevealWindowFixture() {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      setWindowButtonPosition: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    return { browserWindowInstance, windowHandlers }
  }

  function createStartupRevealStore(savedMaximized: boolean) {
    return {
      getUI: () =>
        ({
          windowMaximized: savedMaximized
        }) as never,
      getSettings: () => ({ windowBackgroundBlur: false }) as never,
      updateUI: vi.fn()
    }
  }

  it('ignores duplicate ready-to-show events after startup maximize has already run', () => {
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()

    createMainWindow({
      getUI: () =>
        ({
          windowMaximized: true
        }) as never,
      getSettings: () => ({ windowBackgroundBlur: false }) as never,
      updateUI: vi.fn()
    } as never)

    windowHandlers['ready-to-show']()
    windowHandlers['ready-to-show']()

    expect(browserWindowInstance.maximize).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
  })

  it('reveals the startup window on Windows when ready-to-show never fires', () => {
    vi.useFakeTimers()
    const { browserWindowInstance } = createStartupRevealWindowFixture()

    withPlatform('win32', () => {
      createMainWindow(null)
      vi.advanceTimersByTime(9_999)
      expect(browserWindowInstance.show).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)

      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    })
  })

  it('cancels the Windows startup reveal fallback after ready-to-show', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()

    withPlatform('win32', () => {
      createMainWindow(null)
      windowHandlers['ready-to-show']()
      vi.advanceTimersByTime(10_000)

      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    })
  })

  it('does not install the startup reveal fallback off Windows', () => {
    vi.useFakeTimers()
    const { browserWindowInstance } = createStartupRevealWindowFixture()

    withPlatform('linux', () => {
      createMainWindow(null)
      vi.advanceTimersByTime(10_000)

      expect(browserWindowInstance.show).not.toHaveBeenCalled()
      expect(browserWindowInstance.maximize).not.toHaveBeenCalled()
    })
  })

  it('keeps the headless E2E window hidden when the Windows fallback fires', () => {
    vi.useFakeTimers()
    const previousHeadless = process.env.ORCA_E2E_HEADLESS
    process.env.ORCA_E2E_HEADLESS = '1'
    const { browserWindowInstance } = createStartupRevealWindowFixture()

    try {
      withPlatform('win32', () => {
        createMainWindow(createStartupRevealStore(true) as never)
        vi.advanceTimersByTime(10_000)

        expect(browserWindowInstance.show).not.toHaveBeenCalled()
        expect(browserWindowInstance.maximize).not.toHaveBeenCalled()
      })
    } finally {
      if (previousHeadless === undefined) {
        delete process.env.ORCA_E2E_HEADLESS
      } else {
        process.env.ORCA_E2E_HEADLESS = previousHeadless
      }
    }
  })

  it('clears the Windows startup reveal fallback when the window is closed', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()

    withPlatform('win32', () => {
      createMainWindow(createStartupRevealStore(true) as never)
      windowHandlers.closed()
      vi.advanceTimersByTime(10_000)

      expect(browserWindowInstance.show).not.toHaveBeenCalled()
      expect(browserWindowInstance.maximize).not.toHaveBeenCalled()
    })
  })

  it('does not show or maximize a destroyed window when the Windows fallback fires', () => {
    vi.useFakeTimers()
    const { browserWindowInstance } = createStartupRevealWindowFixture()

    withPlatform('win32', () => {
      createMainWindow(createStartupRevealStore(true) as never)
      browserWindowInstance.isDestroyed.mockReturnValue(true)
      vi.advanceTimersByTime(10_000)

      expect(browserWindowInstance.show).not.toHaveBeenCalled()
      expect(browserWindowInstance.maximize).not.toHaveBeenCalled()
    })
  })

  describe('minimize to tray on close (win32)', () => {
    const originalPlatform = process.platform

    function setPlatform(platform: NodeJS.Platform): void {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    }

    type CloseFixture = {
      windowHandlers: Record<string, (...args: any[]) => void>
      webContents: { send: ReturnType<typeof vi.fn> }
      instance: { hide: ReturnType<typeof vi.fn>; isMinimized: ReturnType<typeof vi.fn> }
    }

    function setupCloseWindow(): CloseFixture {
      const windowHandlers: Record<string, (...args: any[]) => void> = {}
      const webContents = {
        on: vi.fn((event, handler) => {
          windowHandlers[event] = handler
        }),
        setZoomLevel: vi.fn(),
        setBackgroundThrottling: vi.fn(),
        invalidate: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        send: vi.fn(),
        isCrashed: vi.fn(() => false),
        id: 1
      }
      const instance = {
        webContents,
        on: vi.fn((event, handler) => {
          windowHandlers[event] = handler
        }),
        isDestroyed: vi.fn(() => false),
        isMaximized: vi.fn(() => false),
        isFullScreen: vi.fn(() => false),
        isMinimized: vi.fn(() => false),
        getSize: vi.fn(() => [1200, 800]),
        setSize: vi.fn(),
        maximize: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
        loadFile: vi.fn(),
        loadURL: vi.fn()
      }
      browserWindowMock.mockImplementation(function () {
        return instance
      })
      return { windowHandlers, webContents, instance }
    }

    function makeStore(minimizeToTrayOnClose: boolean, trayMinimizeNoticeShown: boolean) {
      return {
        getUI: vi.fn(() => ({ trayMinimizeNoticeShown })),
        getSettings: vi.fn(() => ({ windowBackgroundBlur: false, minimizeToTrayOnClose })),
        updateUI: vi.fn()
      }
    }

    afterEach(() => {
      setPlatform(originalPlatform)
    })

    it('hides to the tray instead of closing when the setting is on', () => {
      setPlatform('win32')
      const { windowHandlers, webContents, instance } = setupCloseWindow()
      const store = makeStore(true, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      const preventDefault = vi.fn()
      windowHandlers.close({ preventDefault } as never)

      expect(preventDefault).toHaveBeenCalled()
      expect(instance.hide).toHaveBeenCalledTimes(1)
      expect(webContents.send).not.toHaveBeenCalledWith('window:close-requested', expect.anything())
      // Notice already shown, so it must not fire again.
      expect(notificationMock).not.toHaveBeenCalled()
    })

    it('keeps the normal close flow when the setting is off', () => {
      setPlatform('win32')
      const { windowHandlers, webContents, instance } = setupCloseWindow()
      const store = makeStore(false, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      windowHandlers.close({ preventDefault: vi.fn() } as never)

      expect(instance.hide).not.toHaveBeenCalled()
      expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
        isQuitting: false
      })
    })

    it('does not hide on a real quit even with the setting on', () => {
      setPlatform('win32')
      const { windowHandlers, webContents, instance } = setupCloseWindow()
      const store = makeStore(true, true)

      createMainWindow(store as never, { getIsQuitting: () => true })
      windowHandlers.close({ preventDefault: vi.fn() } as never)

      expect(instance.hide).not.toHaveBeenCalled()
      expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
        isQuitting: true
      })
    })

    it('does not hide when the renderer process is gone', () => {
      setPlatform('win32')
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { windowHandlers, instance } = setupCloseWindow()
      const store = makeStore(true, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      windowHandlers['render-process-gone']?.(
        {} as never,
        { reason: 'crashed', exitCode: 5 } as never
      )
      const preventDefault = vi.fn()
      windowHandlers.close({ preventDefault } as never)

      expect(instance.hide).not.toHaveBeenCalled()
      expect(preventDefault).not.toHaveBeenCalled()
      consoleError.mockRestore()
    })

    it('shows the first-run notification once and persists the flag', () => {
      setPlatform('win32')
      const { windowHandlers } = setupCloseWindow()
      const store = makeStore(true, false)

      createMainWindow(store as never, { getIsQuitting: () => false })
      windowHandlers.close({ preventDefault: vi.fn() } as never)

      expect(notificationMock).toHaveBeenCalledTimes(1)
      expect(notificationShowMock).toHaveBeenCalledTimes(1)
      expect(store.updateUI).toHaveBeenCalledWith({ trayMinimizeNoticeShown: true })
    })

    it('leaves the close handler unchanged off win32', () => {
      setPlatform('darwin')
      const { windowHandlers, webContents, instance } = setupCloseWindow()
      const store = makeStore(true, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      windowHandlers.close({ preventDefault: vi.fn() } as never)

      expect(instance.hide).not.toHaveBeenCalled()
      expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
        isQuitting: false
      })
    })

    // Why: on Windows the renderer-drawn X routes through window:request-close,
    // not the native close event — regression guard for the bug where the app
    // quit instead of hiding because the guard only covered the native event.
    function captureIpcHandlers(): Record<string, (...args: any[]) => void> {
      const ipcHandlers: Record<string, (...args: any[]) => void> = {}
      vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
        ipcHandlers[channel] = handler as (...args: any[]) => void
        return ipcMain
      })
      return ipcHandlers
    }

    it('hides to the tray when the renderer-drawn X requests close', () => {
      setPlatform('win32')
      const ipcHandlers = captureIpcHandlers()
      const { webContents, instance } = setupCloseWindow()
      const store = makeStore(true, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      ipcHandlers['window:request-close']?.()

      expect(instance.hide).toHaveBeenCalledTimes(1)
      expect(webContents.send).not.toHaveBeenCalledWith('window:close-requested', expect.anything())
    })

    it('forwards window:request-close to the renderer when the setting is off', () => {
      setPlatform('win32')
      const ipcHandlers = captureIpcHandlers()
      const { webContents, instance } = setupCloseWindow()
      const store = makeStore(false, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      ipcHandlers['window:request-close']?.()

      expect(instance.hide).not.toHaveBeenCalled()
      expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
        isQuitting: false
      })
    })
  })
})
