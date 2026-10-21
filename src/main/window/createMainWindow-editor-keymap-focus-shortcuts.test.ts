import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
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

type FocusListener = (event: { sender: unknown }, focused: unknown) => void

function mountWindow() {
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
  browserWindowMock.mockImplementation(function () {
    return {
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
  })
  // Why: Ctrl+P is the Emacs line-up chord on every platform; binding quick open to it keeps the
  // test platform-independent (the Linux/Windows default is Mod+P, which already is Ctrl+P).
  createMainWindow(null, { getKeybindings: () => ({ 'worktree.quickOpen': ['Ctrl+P'] }) })
  const registered = vi
    .mocked(ipcMain.on)
    .mock.calls.find(([channel]) => channel === 'ui:setEditorKeymapFocused')?.[1]
  expect(registered).toBeTypeOf('function')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle registers a plain (event, payload) listener that only reads event.sender, which is the shape the test feeds it.
  const setEditorKeymapFocused = registered as FocusListener | undefined
  const press = (input: Record<string, unknown>): ReturnType<typeof vi.fn> => {
    const preventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault },
      {
        type: 'keyDown',
        alt: false,
        shift: false,
        meta: false,
        control: false,
        ...input
      }
    )
    return preventDefault
  }
  return { press, setEditorKeymapFocused, webContents }
}

const ctrlP = { code: 'KeyP', key: 'p', control: true }

describe('createMainWindow editor keymap focus', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  it('yields Emacs chords to a focused Emacs editor and takes them back on blur', () => {
    const { press, setEditorKeymapFocused, webContents } = mountWindow()

    expect(press(ctrlP)).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:openQuickOpen')

    webContents.send.mockClear()
    setEditorKeymapFocused?.({ sender: webContents }, true)
    expect(press(ctrlP)).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalled()

    // Chords the preset does not bind still run while the editor has focus.
    const isDarwin = process.platform === 'darwin'
    const palette = isDarwin
      ? { code: 'KeyJ', key: 'j', meta: true }
      : { code: 'KeyJ', key: 'J', control: true, shift: true }
    expect(press(palette)).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:toggleWorktreePalette')

    webContents.send.mockClear()
    setEditorKeymapFocused?.({ sender: webContents }, false)
    expect(press(ctrlP)).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:openQuickOpen')
  })

  it('ignores focus reports from other senders and non-boolean payloads', () => {
    const { press, setEditorKeymapFocused, webContents } = mountWindow()

    setEditorKeymapFocused?.({ sender: { id: 'guest' } }, true)
    expect(press(ctrlP)).toHaveBeenCalledTimes(1)

    setEditorKeymapFocused?.({ sender: webContents }, 'true')
    expect(press(ctrlP)).toHaveBeenCalledTimes(1)
  })
})
