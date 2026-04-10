import { beforeEach, describe, expect, it, vi } from 'vitest'

const { browserWindowMock, openExternalMock, attachGuestPoliciesMock } = vi.hoisted(() => ({
  browserWindowMock: vi.fn(),
  openExternalMock: vi.fn(),
  attachGuestPoliciesMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: browserWindowMock,
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: openExternalMock }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false }
}))

vi.mock('../../../resources/icon.png?asset', () => ({
  default: 'icon'
}))

vi.mock('../../../resources/icon-dev.png?asset', () => ({
  default: 'icon-dev'
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: {
    attachGuestPolicies: attachGuestPoliciesMock
  }
}))

import { createMainWindow } from './createMainWindow'

describe('createMainWindow', () => {
  beforeEach(() => {
    browserWindowMock.mockReset()
    openExternalMock.mockReset()
    attachGuestPoliciesMock.mockReset()
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

    expect(browserWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({ sandbox: true })
      })
    )

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

    for (const input of [
      { type: 'keyDown', control: true, meta: true, alt: false, key: '-' },
      { type: 'keyDown', control: true, meta: true, alt: false, key: '_' },
      { type: 'keyDown', control: true, meta: true, alt: false, key: 'Minus' },
      { type: 'keyDown', control: true, meta: true, alt: false, key: 'Subtract' },
      { type: 'keyDown', control: true, meta: true, alt: false, key: '', code: 'Minus' },
      { type: 'keyDown', control: true, meta: true, alt: false, key: '', code: 'NumpadSubtract' }
    ]) {
      const preventDefault = vi.fn()
      beforeInputEvent({ preventDefault } as never, input as never)
      expect(preventDefault).toHaveBeenCalledTimes(1)
    }

    expect(webContents.send).toHaveBeenCalledTimes(6)
    expect(webContents.send).toHaveBeenNthCalledWith(1, 'terminal:zoom', 'out')
    expect(webContents.send).toHaveBeenNthCalledWith(2, 'terminal:zoom', 'out')
    expect(webContents.send).toHaveBeenNthCalledWith(3, 'terminal:zoom', 'out')
    expect(webContents.send).toHaveBeenNthCalledWith(4, 'terminal:zoom', 'out')
    expect(webContents.send).toHaveBeenNthCalledWith(5, 'terminal:zoom', 'out')
    expect(webContents.send).toHaveBeenNthCalledWith(6, 'terminal:zoom', 'out')
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
})
