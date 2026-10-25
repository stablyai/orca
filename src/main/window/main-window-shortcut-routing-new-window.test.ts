import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const { sendResolvedWindowShortcutActionMock } = vi.hoisted(() => ({
  sendResolvedWindowShortcutActionMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { send: vi.fn() })
  }
}))
vi.mock('./main-window-shortcut-actions', () => ({
  sendResolvedWindowShortcutAction: sendResolvedWindowShortcutActionMock
}))

import { BrowserWindow } from 'electron'
import { installMainWindowShortcutRouting } from './main-window-shortcut-routing'
import type { MainWindowFocusLifecycle } from './main-window-focus-lifecycle'

function noFocus(): MainWindowFocusLifecycle {
  return {
    dispose: () => {},
    isFloatingPanelFocused: () => false,
    isFloatingTerminalInputFocused: () => false,
    isMarkdownEditorFocused: () => false,
    isRendererProcessGone: () => false,
    isShortcutRecorderFocused: () => false,
    isTerminalInputFocused: () => false,
    notifySystemResume: () => {}
  }
}

function fixture() {
  const mainWindow = new BrowserWindow()
  const { webContents } = mainWindow
  installMainWindowShortcutRouting({
    focus: noFocus(),
    mainWindow,
    store: null
  })
  const dispatch = (input: Partial<Electron.Input>): ReturnType<typeof vi.fn> => {
    const preventDefault = vi.fn()
    webContents.emit(
      'before-input-event',
      { preventDefault, defaultPrevented: false },
      {
        type: 'keyDown',
        alt: true,
        meta: process.platform === 'darwin',
        control: process.platform !== 'darwin',
        shift: false,
        code: 'KeyN',
        key: 'n',
        ...input
      }
    )
    return preventDefault
  }
  return { dispatch }
}

describe('main-window New Window shortcut routing', () => {
  beforeEach(() => sendResolvedWindowShortcutActionMock.mockClear())

  it('invokes the opener exactly once for a single nonrepeated Mod+Alt+N keydown', () => {
    const { dispatch } = fixture()

    const preventDefault = dispatch({})

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(sendResolvedWindowShortcutActionMock).toHaveBeenCalledTimes(1)
    expect(sendResolvedWindowShortcutActionMock).toHaveBeenCalledWith(
      expect.anything(),
      { type: 'newWindow' },
      undefined
    )
  })

  it('suppresses the held-key repeat without invoking the opener again', () => {
    const { dispatch } = fixture()

    dispatch({})
    const repeatPreventDefault = dispatch({ isAutoRepeat: true })

    expect(repeatPreventDefault).toHaveBeenCalledTimes(1)
    expect(sendResolvedWindowShortcutActionMock).toHaveBeenCalledTimes(1)
  })
})
