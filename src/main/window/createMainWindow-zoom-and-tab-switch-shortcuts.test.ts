import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('@electron-toolkit/utils', async () =>
  (await import('./createMainWindow-test-harness')).electronToolkitUtilsMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)

import { createMainWindow } from './createMainWindow'
import { ipcMain } from 'electron'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'

describe('createMainWindow', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  it('supports all minus key variants for terminal zoom out', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      once: vi.fn((event, handler) => {
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

  // While the floating panel owns the keyboard, L1 yields the initial indexed-switch keydown to the
  // renderer (no preventDefault, no dispatch) so L2 selects a floating tab, and it contains held-key
  // repeats in main (preventDefault, no dispatch) since the renderer skips e.repeat.
  it('yields indexed-switch chords to the floating panel and contains their repeats', () => {
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

    const setFloatingFocus = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setFloatingFocus')?.[1]
    expect(setFloatingFocus).toBeTypeOf('function')
    setFloatingFocus?.(
      { sender: webContents } as never,
      { panelFocused: true, terminalFocused: false } as never
    )

    const beforeInputEvent = windowHandlers['before-input-event']
    const isDarwin = process.platform === 'darwin'
    // jumpToTabIndex chord (Ctrl+digit on mac, Alt+digit elsewhere) and jumpToWorktreeIndex chord
    // (Mod+digit) both yield while the panel owns focus.
    const tabIndexInput = isDarwin
      ? { type: 'keyDown', code: 'Digit5', key: '5', meta: false, control: true, alt: false }
      : { type: 'keyDown', code: 'Digit5', key: '5', meta: false, control: false, alt: true }
    const worktreeIndexInput = isDarwin
      ? { type: 'keyDown', code: 'Digit5', key: '5', meta: true, control: false, alt: false }
      : { type: 'keyDown', code: 'Digit5', key: '5', meta: false, control: true, alt: false }

    for (const input of [tabIndexInput, worktreeIndexInput]) {
      // Initial (non-repeat) keydown: yielded to the renderer — neither prevented nor dispatched.
      const yieldPreventDefault = vi.fn()
      beforeInputEvent({ preventDefault: yieldPreventDefault } as never, input as never)
      expect(yieldPreventDefault).not.toHaveBeenCalled()

      // Held-key repeat: contained in main — prevented, still not dispatched.
      const repeatPreventDefault = vi.fn()
      beforeInputEvent(
        { preventDefault: repeatPreventDefault } as never,
        { ...input, isAutoRepeat: true } as never
      )
      expect(repeatPreventDefault).toHaveBeenCalledTimes(1)
    }

    expect(webContents.send).not.toHaveBeenCalledWith('ui:jumpToTabIndex', expect.anything())
    expect(webContents.send).not.toHaveBeenCalledWith('ui:jumpToWorktreeIndex', expect.anything())
  })

  // Held-key repeats are contained in main whether or not the floating panel has focus: every
  // renderer index path skips e.repeat, so yielding one would leak a raw digit to xterm.
  it('contains indexed-switch repeats without dispatching them', () => {
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
    const input = isDarwin
      ? { type: 'keyDown', code: 'Digit3', key: '3', meta: true, control: false, alt: false }
      : { type: 'keyDown', code: 'Digit3', key: '3', meta: false, control: true, alt: false }
    const preventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault } as never,
      { ...input, isAutoRepeat: true } as never
    )

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).not.toHaveBeenCalledWith('ui:jumpToWorktreeIndex', expect.anything())
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
})
