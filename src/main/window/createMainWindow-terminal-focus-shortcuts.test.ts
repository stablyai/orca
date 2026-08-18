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
import { browserWindowMock, isMock, resetMainWindowMocks } from './createMainWindow-test-harness'

describe('createMainWindow', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
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

  it('suppresses auto-repeat quick-command menu toggles from before-input-event', () => {
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

    createMainWindow(null, {
      getKeybindings: () => ({
        'tab.openQuickCommandsMenu': ['Mod+Shift+Q']
      })
    })

    const isDarwin = process.platform === 'darwin'
    const input = {
      type: 'keyDown',
      code: 'KeyQ',
      key: 'q',
      meta: isDarwin,
      control: !isDarwin,
      alt: false,
      shift: true
    }
    const firstPreventDefault = vi.fn()
    windowHandlers['before-input-event']({ preventDefault: firstPreventDefault } as never, input)
    expect(firstPreventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:toggleQuickCommandsMenu')

    webContents.send.mockClear()
    const repeatPreventDefault = vi.fn()
    windowHandlers['before-input-event']({ preventDefault: repeatPreventDefault } as never, {
      ...input,
      isAutoRepeat: true
    })

    expect(repeatPreventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).not.toHaveBeenCalled()
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
})
