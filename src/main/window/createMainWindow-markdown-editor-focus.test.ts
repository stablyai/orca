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
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)

import { createMainWindow } from './createMainWindow'
import { ipcMain } from 'electron'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import {
  browserWindowMock,
  buildFromTemplateMock,
  menuPopupMock,
  resetMainWindowMocks
} from './createMainWindow-test-harness'

function openMainWindowForContextMenu() {
  const windowHandlers: Record<string, (...args: any[]) => void> = {}
  const webContents = {
    on: vi.fn((event, handler) => {
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
    closeDevTools: vi.fn(),
    replaceMisspelling: vi.fn(),
    session: { addWordToSpellCheckerDictionary: vi.fn() },
    getURL: vi.fn(() => 'file:///opt/orca/renderer/index.html'),
    isLoadingMainFrame: vi.fn(() => true)
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

  createMainWindow(null)
  return { webContents, windowHandlers, browserWindowInstance }
}

describe('createMainWindow', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  it('intercepts Cmd+B for sidebar when the markdown editor is not focused', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
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

  it('leaves bold and logical link shortcuts to the focused markdown editor', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
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

    createMainWindow(null)

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setMarkdownEditorFocused')?.[1]
    expect(setFocusedListener).toBeTypeOf('function')
    setFocusedListener?.({ sender: webContents } as never, true)

    const event = new Event('before-input-event', { cancelable: true })
    const isDarwin = process.platform === 'darwin'
    windowHandlers['before-input-event'](event, {
      type: 'keyDown',
      code: 'KeyB',
      key: 'b',
      meta: isDarwin,
      control: !isDarwin,
      alt: false,
      shift: false
    } as never)

    windowHandlers['before-input-event'](event, {
      type: 'keyDown',
      code: 'KeyV',
      key: 'k',
      meta: isDarwin,
      control: !isDarwin,
      alt: false,
      shift: false
    })
    expect(event.defaultPrevented).toBe(false)
  })

  it('lets the shortcut recorder capture app shortcuts before main interception', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
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

    createMainWindow(null)

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setFloatingFocus')?.[1]
    expect(setFocusedListener).toBeTypeOf('function')
    setFocusedListener?.(
      { sender: webContents } as never,
      { panelFocused: true, terminalFocused: true } as never
    )

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

  it('retires the edit menu with its document but not on same-document navigation', () => {
    const { webContents } = openMainWindowForContextMenu()
    const emit = (event: string, ...args: unknown[]): void => {
      for (const [name, handler] of webContents.on.mock.calls) {
        if (name === event) {
          handler(...args)
        }
      }
    }
    const openMenu = () => {
      const closePopup = vi.fn()
      buildFromTemplateMock.mockImplementationOnce(() => ({
        popup: menuPopupMock,
        closePopup
      }))
      emit(
        'context-menu',
        {},
        {
          x: 1,
          y: 2,
          isEditable: true,
          formControlType: 'input',
          dictionarySuggestions: [],
          misspelledWord: ''
        }
      )
      const template = buildFromTemplateMock.mock.calls.at(-1)?.[0]
      const paste = Array.isArray(template)
        ? template.find((item) => item.label === 'Paste')
        : undefined
      expect(paste?.click).toBeTypeOf('function')
      return { closePopup, paste }
    }
    const nextDocument = 'file:///opt/orca/renderer/index.html?reload'

    const first = openMenu()
    emit('did-start-navigation', {}, `${nextDocument}#hash`, true, true)
    expect(first.closePopup).not.toHaveBeenCalled()
    emit('did-start-navigation', {}, nextDocument, false, true)
    expect(first.closePopup).toHaveBeenCalledTimes(1)

    // The old document still takes right-clicks until the pending reload commits.
    const pending = openMenu()
    emit('did-frame-navigate', {}, nextDocument, 200, 'OK', false)
    expect(pending.closePopup).not.toHaveBeenCalled()
    emit('did-frame-navigate', {}, nextDocument, 200, 'OK', true)
    expect(pending.closePopup).toHaveBeenCalledTimes(1)
    pending.paste.click()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:editableContextPaste', expect.anything())
  })
})
