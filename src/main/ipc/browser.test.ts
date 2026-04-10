import { beforeEach, describe, expect, it, vi } from 'vitest'

const { removeHandlerMock, handleMock, registerGuestMock, unregisterGuestMock, openDevToolsMock } =
  vi.hoisted(() => ({
    removeHandlerMock: vi.fn(),
    handleMock: vi.fn(),
    registerGuestMock: vi.fn(),
    unregisterGuestMock: vi.fn(),
    openDevToolsMock: vi.fn().mockResolvedValue(true)
  }))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock
  }
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: {
    registerGuest: registerGuestMock,
    unregisterGuest: unregisterGuestMock,
    openDevTools: openDevToolsMock
  }
}))

import { registerBrowserHandlers } from './browser'

describe('registerBrowserHandlers', () => {
  beforeEach(() => {
    removeHandlerMock.mockReset()
    handleMock.mockReset()
    registerGuestMock.mockReset()
    unregisterGuestMock.mockReset()
    openDevToolsMock.mockReset()
    openDevToolsMock.mockResolvedValue(true)
  })

  it('rejects non-window callers', async () => {
    registerBrowserHandlers()

    const registerHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:registerGuest'
    )?.[1] as (event: { sender: Electron.WebContents }, args: unknown) => boolean

    const result = registerHandler(
      {
        sender: {
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'http://localhost:5173/'
        } as Electron.WebContents
      },
      { browserTabId: 'browser-1', webContentsId: 101 }
    )

    expect(result).toBe(false)
    expect(registerGuestMock).not.toHaveBeenCalled()
  })
})
