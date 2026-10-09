import type { KeybindingOverrides } from '../../shared/keybindings'
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

function historyBackInput(): Record<string, unknown> {
  const isDarwin = process.platform === 'darwin'
  return {
    type: 'keyDown',
    code: 'ArrowLeft',
    key: 'ArrowLeft',
    meta: isDarwin,
    control: !isDarwin,
    alt: true,
    shift: false
  }
}

function emitBeforeInput(
  handler: ((...args: unknown[]) => void) | undefined,
  preventDefault: () => void,
  input: Record<string, unknown>
): void {
  handler?.({ preventDefault }, input)
}

function mountMainWindow(
  keybindings?: KeybindingOverrides,
  terminalShortcutPolicy: 'orca-first' | 'terminal-first' = 'orca-first'
): {
  windowHandlers: Record<string, (...args: unknown[]) => void>
  webContents: { send: ReturnType<typeof vi.fn> }
} {
  const windowHandlers: Record<string, (...args: unknown[]) => void> = {}
  const webContents = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
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
    loadFile: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve())
  }
  browserWindowMock.mockImplementation(function () {
    return browserWindowInstance
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: window setup reads only these store methods in this mocked harness.
  const store = {
    getUI: () => ({}),
    getSettings: () => ({ terminalShortcutPolicy }),
    updateUI: vi.fn()
  } as unknown as NonNullable<Parameters<typeof createMainWindow>[0]>
  createMainWindow(store, { getKeybindings: () => keybindings ?? {} })
  return { windowHandlers, webContents }
}

describe('createMainWindow spatial pane focus shortcuts', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  it('still intercepts worktree history when a terminal is not focused', () => {
    const { windowHandlers, webContents } = mountMainWindow()
    const preventDefault = vi.fn()
    emitBeforeInput(windowHandlers['before-input-event'], preventDefault, historyBackInput())

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:worktreeHistoryNavigate', 'back')
  })

  it('yields worktree-history chords to the renderer while a terminal is focused', () => {
    const { windowHandlers, webContents } = mountMainWindow()
    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setTerminalInputFocused')?.[1]
    expect(setFocusedListener).toBeTypeOf('function')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the focus listener only reads sender identity from this mocked IPC event.
    setFocusedListener?.({ sender: webContents } as unknown as Electron.IpcMainEvent, true)

    const preventDefault = vi.fn()
    emitBeforeInput(windowHandlers['before-input-event'], preventDefault, historyBackInput())

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:worktreeHistoryNavigate', 'back')
  })
  it.each([{ 'terminal.focusPaneLeft': [] }, { 'terminal.focusPaneLeft': ['Ctrl+H'] }])(
    'keeps history when spatial focus no longer matches: %j',
    (bindings) => {
      const { windowHandlers, webContents } = mountMainWindow(bindings)
      const listener = vi
        .mocked(ipcMain.on)
        .mock.calls.find(([channel]) => channel === 'ui:setTerminalInputFocused')?.[1]
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked focus listener only reads sender identity.
      listener?.({ sender: webContents } as unknown as Electron.IpcMainEvent, true)
      const preventDefault = vi.fn()
      emitBeforeInput(windowHandlers['before-input-event'], preventDefault, historyBackInput())
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(webContents.send).toHaveBeenCalledWith('ui:worktreeHistoryNavigate', 'back')
    }
  )

  it('yields a history conflict with a rebound vertical action, including held repeats', () => {
    const { windowHandlers, webContents } = mountMainWindow({
      'terminal.focusPaneLeft': [],
      'terminal.focusPaneUp': ['Mod+Alt+ArrowLeft']
    })
    const listener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setTerminalInputFocused')?.[1]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked focus listener only reads sender identity.
    listener?.({ sender: webContents } as unknown as Electron.IpcMainEvent, true)
    for (const isAutoRepeat of [false, true]) {
      const preventDefault = vi.fn()
      emitBeforeInput(windowHandlers['before-input-event'], preventDefault, {
        ...historyBackInput(),
        isAutoRepeat
      })
      expect(preventDefault).not.toHaveBeenCalled()
    }
    expect(webContents.send).not.toHaveBeenCalledWith('ui:worktreeHistoryNavigate', 'back')
  })
  it.each([false, true])('respects terminal-first history policy (floating=%s)', (floating) => {
    const { windowHandlers, webContents } = mountMainWindow(
      { 'terminal.focusPaneLeft': [] },
      'terminal-first'
    )
    const listener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(
        ([channel]) => channel === (floating ? 'ui:setFloatingFocus' : 'ui:setTerminalInputFocused')
      )?.[1]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked focus listener only reads sender identity.
    const focusEvent = { sender: webContents } as unknown as Electron.IpcMainEvent
    listener?.(focusEvent, floating ? { panelFocused: true, terminalFocused: true } : true)
    const preventDefault = vi.fn()
    emitBeforeInput(windowHandlers['before-input-event'], preventDefault, historyBackInput())
    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:worktreeHistoryNavigate', 'back')
  })

  it('retains main-process double-tap history ownership inside a terminal', () => {
    const { windowHandlers, webContents } = mountMainWindow({
      'worktree.history.back': ['DoubleTap+Shift'],
      'terminal.focusPaneLeft': ['DoubleTap+Shift']
    })
    const listener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setTerminalInputFocused')?.[1]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked focus listener only reads sender identity.
    listener?.({ sender: webContents } as unknown as Electron.IpcMainEvent, true)
    const preventDefault = vi.fn()
    for (const type of ['keyDown', 'keyUp', 'keyDown']) {
      emitBeforeInput(windowHandlers['before-input-event'], preventDefault, {
        type,
        code: 'ShiftLeft',
        key: 'Shift',
        shift: true,
        meta: false,
        control: false,
        alt: false
      })
    }
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(webContents.send).toHaveBeenCalledWith('ui:worktreeHistoryNavigate', 'back')
  })
})
