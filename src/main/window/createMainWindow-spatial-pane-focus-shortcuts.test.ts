import type { KeybindingOverrides } from '../../shared/keybindings'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('./desktop-integration/app-icon', async () =>
  (await import('./createMainWindow-test-harness')).appIconMock()
)
vi.mock('../browser/guest-lifecycle/manager/browser-manager', async () =>
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

function mountFocusedTerminal(
  keybindings?: KeybindingOverrides,
  focusChannel = 'ui:setTerminalInputFocused'
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
    setWebRTCIPHandlingPolicy: vi.fn(),
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
    getSettings: () => ({ terminalShortcutPolicy: 'orca-first' }),
    updateUI: vi.fn()
  } as unknown as NonNullable<Parameters<typeof createMainWindow>[0]>
  createMainWindow(store, { getKeybindings: () => keybindings ?? {} })
  const setFocusedListener = vi
    .mocked(ipcMain.on)
    .mock.calls.find(([channel]) => channel === focusChannel)?.[1]
  if (!setFocusedListener) {
    throw new Error(`Expected ${focusChannel} listener`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the focus listener only reads sender identity from this mocked IPC event.
  setFocusedListener({ sender: webContents } as unknown as Electron.IpcMainEvent, true)
  return { windowHandlers, webContents }
}

describe('createMainWindow spatial pane focus shortcuts', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  it.each([
    { surface: 'a terminal', focusChannel: 'ui:setTerminalInputFocused' },
    { surface: 'a native chat cover', focusChannel: 'ui:setNativeChatCoverFocused' }
  ])(
    'yields worktree-history chords, held repeats included, while $surface is focused',
    ({ focusChannel }) => {
      const { windowHandlers, webContents } = mountFocusedTerminal(undefined, focusChannel)
      // The renderer walks panes on repeats, so main must neither absorb them nor replay history.
      for (const isAutoRepeat of [false, true]) {
        const preventDefault = vi.fn()
        emitBeforeInput(windowHandlers['before-input-event'], preventDefault, {
          ...historyBackInput(),
          isAutoRepeat
        })
        expect(preventDefault).not.toHaveBeenCalled()
      }
      expect(webContents.send).not.toHaveBeenCalledWith('ui:worktreeHistoryNavigate', 'back')
    }
  )

  it('yields a history conflict with a rebound vertical action, including held repeats', () => {
    const { windowHandlers, webContents } = mountFocusedTerminal({
      'terminal.focusPaneLeft': [],
      'terminal.focusPaneUp': ['Mod+Alt+ArrowLeft']
    })
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

  it('keeps worktree history in a focused terminal once spatial focus is unbound', () => {
    const { windowHandlers, webContents } = mountFocusedTerminal({ 'terminal.focusPaneLeft': [] })
    const preventDefault = vi.fn()
    emitBeforeInput(windowHandlers['before-input-event'], preventDefault, historyBackInput())
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(webContents.send).toHaveBeenCalledWith('ui:worktreeHistoryNavigate', 'back')
  })

  it('keeps a non-history main action that shares a spatial chord in a focused terminal', () => {
    const { windowHandlers, webContents } = mountFocusedTerminal({
      'worktree.history.back': [],
      'app.settings': ['Mod+Alt+ArrowLeft']
    })
    const preventDefault = vi.fn()
    emitBeforeInput(windowHandlers['before-input-event'], preventDefault, historyBackInput())
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(webContents.send).toHaveBeenCalledWith('ui:openSettings')
  })
})
