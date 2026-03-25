import { beforeEach, describe, expect, it, vi } from 'vitest'

const { browserWindowMock, openExternalMock } = vi.hoisted(() => ({
  browserWindowMock: vi.fn(),
  openExternalMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: browserWindowMock,
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

import { createMainWindow } from './createMainWindow'

describe('createMainWindow', () => {
  beforeEach(() => {
    browserWindowMock.mockReset()
    openExternalMock.mockReset()
  })

  it('enables renderer sandboxing and only opens http(s) URLs externally', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setWindowOpenHandler: vi.fn((handler) => {
        windowHandlers.windowOpen = handler
      }),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
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
    expect(windowHandlers.windowOpen({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(windowHandlers.windowOpen({ url: 'not a url' })).toEqual({ action: 'deny' })

    expect(openExternalMock).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com')
  })
})
