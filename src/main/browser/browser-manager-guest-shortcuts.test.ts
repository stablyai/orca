import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const browserMocks = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => '/downloads'),
  shellOpenExternalMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  menuBuildFromTemplateMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestOpenDevToolsMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 })),
  openPopupWithOriginBarMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: browserMocks.appGetPathMock
  },
  BrowserWindow: {
    fromWebContents: browserMocks.browserWindowFromWebContentsMock
  },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: browserMocks.shellOpenExternalMock },
  Menu: {
    buildFromTemplate: browserMocks.menuBuildFromTemplateMock
  },
  screen: {
    getCursorScreenPoint: browserMocks.screenGetCursorScreenPointMock
  },
  webContents: {
    fromId: browserMocks.webContentsFromIdMock
  }
}))

vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from './browser-manager'
import {
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'

const {
  guestOffMock,
  guestOnMock,
  guestSetBackgroundThrottlingMock,
  guestSetWindowOpenHandlerMock,
  guestOpenDevToolsMock,
  webContentsFromIdMock
} = browserMocks

describe('browserManager', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not forward ctrl/cmd+r or readline chords from browser guests', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 405,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }

    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const beforeInputHandler = guestOnMock.mock.calls.findLast(
      ([event]) => event === 'before-input-event'
    )?.[1] as
      | ((event: { preventDefault: () => void }, input: Record<string, unknown>) => void)
      | undefined

    expect(beforeInputHandler).toBeTypeOf('function')

    // Why: on Linux, Ctrl is the shortcut modifier, so Ctrl+R is the reload
    // shortcut (not a readline chord). Only test Ctrl+R as a readline passthrough
    // on macOS where Cmd is the modifier and Ctrl+R is genuinely a readline chord.
    const readlineChords = [
      ...(process.platform === 'darwin'
        ? [
            {
              type: 'keyDown',
              code: 'KeyR',
              key: 'r',
              meta: false,
              control: true,
              alt: false,
              shift: false
            }
          ]
        : []),
      {
        type: 'keyDown',
        code: 'KeyU',
        key: 'u',
        meta: false,
        control: true,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyE',
        key: 'e',
        meta: false,
        control: true,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyJ',
        key: 'j',
        meta: false,
        control: true,
        alt: false,
        shift: false
      }
    ]
    for (const input of readlineChords) {
      const preventDefault = vi.fn()
      beforeInputHandler?.({ preventDefault }, input)
      expect(preventDefault).not.toHaveBeenCalled()
    }

    expect(rendererSendMock).not.toHaveBeenCalled()
  })

  it('forwards browser guest tab shortcuts alongside shared window shortcuts', () => {
    const isDarwin = process.platform === 'darwin'
    const rendererSendMock = vi.fn()
    const guest = {
      id: 406,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }

    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const beforeInputHandler = guestOnMock.mock.calls.findLast(
      ([event]) => event === 'before-input-event'
    )?.[1] as
      | ((event: { preventDefault: () => void }, input: Record<string, unknown>) => void)
      | undefined

    expect(beforeInputHandler).toBeTypeOf('function')

    const inputs = [
      {
        type: 'keyDown',
        code: 'KeyB',
        key: 'b',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: true
      },
      {
        type: 'keyDown',
        code: 'KeyT',
        key: 't',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyW',
        key: 'w',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'BracketRight',
        key: '}',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: true
      },
      {
        type: 'keyDown',
        code: 'BracketRight',
        key: ']',
        meta: isDarwin,
        control: !isDarwin,
        alt: true,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'PageDown',
        key: 'PageDown',
        meta: false,
        control: true,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyP',
        key: 'p',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyL',
        key: 'l',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyR',
        key: 'r',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyR',
        key: 'r',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: true
      }
    ]

    for (const input of inputs) {
      const preventDefault = vi.fn()
      beforeInputHandler?.({ preventDefault }, input)
      expect(preventDefault).toHaveBeenCalledTimes(1)
    }

    expect(rendererSendMock).toHaveBeenNthCalledWith(1, 'ui:newBrowserTab')
    expect(rendererSendMock).toHaveBeenNthCalledWith(2, 'ui:newTerminalTab')
    expect(rendererSendMock).toHaveBeenNthCalledWith(3, 'ui:closeActiveTab', {
      sourceId: 'browser-1'
    })
    expect(rendererSendMock).toHaveBeenNthCalledWith(4, 'ui:switchTabAcrossAllTypes', 1)
    expect(rendererSendMock).toHaveBeenNthCalledWith(5, 'ui:switchTab', 1)
    expect(rendererSendMock).toHaveBeenNthCalledWith(6, 'ui:switchTerminalTab', 1)
    expect(rendererSendMock).toHaveBeenNthCalledWith(7, 'ui:openQuickOpen')
    expect(rendererSendMock).toHaveBeenNthCalledWith(8, 'ui:focusBrowserAddressBar')
    expect(rendererSendMock).toHaveBeenNthCalledWith(9, 'ui:reloadBrowserPage')
    expect(rendererSendMock).toHaveBeenNthCalledWith(10, 'ui:hardReloadBrowserPage')
  })

  it('uses customized keybindings when forwarding browser guest shortcuts', () => {
    const isDarwin = process.platform === 'darwin'
    const primary = { meta: isDarwin, control: !isDarwin }
    const rendererSendMock = vi.fn()
    const guest = {
      id: 407,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }

    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })
    browserManager.setSettingsResolver(() => ({
      keybindings: {
        'tab.newBrowser': ['Mod+Alt+B'],
        'worktree.quickOpen': ['Mod+Shift+O']
      }
    }))

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const beforeInputHandler = guestOnMock.mock.calls.findLast(
      ([event]) => event === 'before-input-event'
    )?.[1] as
      | ((event: { preventDefault: () => void }, input: Record<string, unknown>) => void)
      | undefined

    expect(beforeInputHandler).toBeTypeOf('function')

    const defaultBrowserPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: defaultBrowserPreventDefault },
      {
        type: 'keyDown',
        code: 'KeyB',
        key: 'b',
        ...primary,
        alt: false,
        shift: true
      }
    )
    expect(defaultBrowserPreventDefault).not.toHaveBeenCalled()

    const customBrowserPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: customBrowserPreventDefault },
      {
        type: 'keyDown',
        code: 'KeyB',
        key: 'b',
        ...primary,
        alt: true,
        shift: false
      }
    )
    expect(customBrowserPreventDefault).toHaveBeenCalledTimes(1)

    const defaultQuickOpenPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: defaultQuickOpenPreventDefault },
      {
        type: 'keyDown',
        code: 'KeyP',
        key: 'p',
        ...primary,
        alt: false,
        shift: false
      }
    )
    expect(defaultQuickOpenPreventDefault).not.toHaveBeenCalled()

    const customQuickOpenPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: customQuickOpenPreventDefault },
      {
        type: 'keyDown',
        code: 'KeyO',
        key: 'o',
        ...primary,
        alt: false,
        shift: true
      }
    )
    expect(customQuickOpenPreventDefault).toHaveBeenCalledTimes(1)

    expect(rendererSendMock).toHaveBeenNthCalledWith(1, 'ui:newBrowserTab')
    expect(rendererSendMock).toHaveBeenNthCalledWith(2, 'ui:openQuickOpen')
  })

  it('forwards browser guest Ctrl+Tab keydown and Ctrl release', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 407,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }

    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const beforeInputHandler = guestOnMock.mock.calls.findLast(
      ([event]) => event === 'before-input-event'
    )?.[1] as
      | ((event: { preventDefault: () => void }, input: Record<string, unknown>) => void)
      | undefined

    const keyDownPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: keyDownPreventDefault },
      {
        type: 'keyDown',
        code: 'Tab',
        key: 'Tab',
        meta: false,
        control: true,
        alt: false,
        shift: false
      }
    )
    const keyUpPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: keyUpPreventDefault },
      {
        type: 'keyUp',
        code: 'ControlRight',
        key: 'Control',
        meta: false,
        control: false,
        alt: false,
        shift: false
      }
    )

    // Why: keydown must not preventDefault or Electron drops the commit keyup.
    expect(keyDownPreventDefault).not.toHaveBeenCalled()
    expect(keyUpPreventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenNthCalledWith(1, 'ui:ctrlTabKeyDown', { shiftKey: false })
    expect(rendererSendMock).toHaveBeenNthCalledWith(2, 'ui:ctrlTabKeyUp')
  })

  it('respects disabled browser guest tab-switch bindings', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 408,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }

    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })
    browserManager.setSettingsResolver(() => ({
      keybindings: {
        'tab.previousRecent': [],
        'tab.nextTerminal': [],
        'tab.previousTerminal': []
      }
    }))

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const beforeInputHandler = guestOnMock.mock.calls.findLast(
      ([event]) => event === 'before-input-event'
    )?.[1] as
      | ((event: { preventDefault: () => void }, input: Record<string, unknown>) => void)
      | undefined

    const ctrlTabPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: ctrlTabPreventDefault },
      {
        type: 'keyDown',
        code: 'Tab',
        key: 'Tab',
        meta: false,
        control: true,
        alt: false,
        shift: false
      }
    )

    const terminalTabPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: terminalTabPreventDefault },
      {
        type: 'keyDown',
        code: 'PageDown',
        key: 'PageDown',
        meta: false,
        control: true,
        alt: false,
        shift: false
      }
    )

    expect(ctrlTabPreventDefault).not.toHaveBeenCalled()
    expect(terminalTabPreventDefault).not.toHaveBeenCalled()
    expect(rendererSendMock).not.toHaveBeenCalledWith('ui:ctrlTabKeyDown', expect.anything())
    expect(rendererSendMock).not.toHaveBeenCalledWith('ui:switchTerminalTab', expect.anything())
  })
})
