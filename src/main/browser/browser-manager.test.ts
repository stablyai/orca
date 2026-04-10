import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  shellOpenExternalMock,
  menuBuildFromTemplateMock,
  guestOffMock,
  guestOnMock,
  guestSetBackgroundThrottlingMock,
  guestSetWindowOpenHandlerMock,
  guestOpenDevToolsMock,
  webContentsFromIdMock
} = vi.hoisted(() => ({
  shellOpenExternalMock: vi.fn(),
  menuBuildFromTemplateMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestOpenDevToolsMock: vi.fn(),
  webContentsFromIdMock: vi.fn()
}))

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: shellOpenExternalMock },
  Menu: {
    buildFromTemplate: menuBuildFromTemplateMock
  },
  webContents: {
    fromId: webContentsFromIdMock
  }
}))

import { browserManager } from './browser-manager'

describe('browserManager', () => {
  beforeEach(() => {
    shellOpenExternalMock.mockReset()
    menuBuildFromTemplateMock.mockReset()
    guestOffMock.mockReset()
    guestOnMock.mockReset()
    guestSetBackgroundThrottlingMock.mockReset()
    guestSetWindowOpenHandlerMock.mockReset()
    guestOpenDevToolsMock.mockReset()
    webContentsFromIdMock.mockReset()
    browserManager.unregisterAll()
  })

  it('validates popup URLs before opening externally', () => {
    const guest = {
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.registerGuest({ browserTabId: 'browser-1', webContentsId: 101 })

    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0] as (details: {
      url: string
    }) => { action: 'deny' }

    expect(handler({ url: 'localhost:3000' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })

    expect(shellOpenExternalMock).toHaveBeenCalledTimes(1)
    expect(shellOpenExternalMock).toHaveBeenCalledWith('http://localhost:3000/')
  })

  it('unregisterAll clears tracked guests and context-menu listeners', () => {
    const guest = {
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.registerGuest({ browserTabId: 'browser-1', webContentsId: 101 })
    browserManager.registerGuest({ browserTabId: 'browser-2', webContentsId: 102 })

    browserManager.unregisterAll()

    expect(browserManager.getGuestWebContentsId('browser-1')).toBeNull()
    expect(browserManager.getGuestWebContentsId('browser-2')).toBeNull()
    expect(guestOffMock).toHaveBeenCalled()
  })

  it('rejects non-webview guest types to prevent privilege escalation', () => {
    // A compromised renderer could send the main window's own webContentsId.
    // registerGuest must reject it because getType() would return 'window',
    // not 'webview'.
    const mainWindowContents = {
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'window'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockReturnValue(mainWindowContents)

    browserManager.registerGuest({ browserTabId: 'browser-evil', webContentsId: 1 })

    // The guest should NOT be registered
    expect(browserManager.getGuestWebContentsId('browser-evil')).toBeNull()
    // setWindowOpenHandler must NOT have been called on the main window's webContents
    expect(guestSetWindowOpenHandlerMock).not.toHaveBeenCalled()
  })
})
