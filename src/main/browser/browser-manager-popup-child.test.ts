import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const browserMocks = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => '/downloads'),
  menuBuildFromTemplateMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestOpenDevToolsMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 })),
  shellOpenExternalMock: vi.fn(),
  openPopupWithOriginBarMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: browserMocks.appGetPathMock },
  BrowserWindow: { fromWebContents: browserMocks.browserWindowFromWebContentsMock },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: browserMocks.shellOpenExternalMock },
  Menu: { buildFromTemplate: browserMocks.menuBuildFromTemplateMock },
  screen: { getCursorScreenPoint: browserMocks.screenGetCursorScreenPointMock },
  webContents: { fromId: browserMocks.webContentsFromIdMock }
}))

vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from './browser-manager'
import {
  createDownloadItem,
  getDownloadItemEventHandler,
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
  webContentsFromIdMock,
  shellOpenExternalMock
} = browserMocks

describe('browserManager popup child policies', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('attaches guest policies to created popup child windows', () => {
    const rendererSendMock = vi.fn()
    const childSetBackgroundThrottlingMock = vi.fn()
    const childSetWindowOpenHandlerMock = vi.fn()
    const childOnMock = vi.fn()
    const childOffMock = vi.fn()
    const childOpenDevToolsMock = vi.fn()
    const childGuest = {
      id: 4040,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: childSetBackgroundThrottlingMock,
      setWindowOpenHandler: childSetWindowOpenHandlerMock,
      on: childOnMock,
      off: childOffMock,
      openDevTools: childOpenDevToolsMock
    }
    const guest = {
      id: 404,
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

    const didCreateWindowHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-create-window'
    )?.[1] as ((window: { webContents: typeof childGuest }) => void) | undefined
    expect(didCreateWindowHandler).toBeTypeOf('function')

    didCreateWindowHandler?.({ webContents: childGuest })

    expect(childSetBackgroundThrottlingMock).toHaveBeenCalledWith(false)
    expect(childSetWindowOpenHandlerMock).toHaveBeenCalledTimes(1)
    expect(childOnMock.mock.calls.filter(([event]) => event === 'did-create-window')).toHaveLength(
      1
    )
    expect(childOnMock.mock.calls.filter(([event]) => event === 'will-navigate')).toHaveLength(1)
    expect(childOnMock.mock.calls.filter(([event]) => event === 'will-redirect')).toHaveLength(1)

    const childWindowOpenHandler = childSetWindowOpenHandlerMock.mock.calls[0][0] as (details: {
      url: string
    }) => { action: 'allow' | 'deny' }
    expect(childWindowOpenHandler({ url: 'https://identity.example.com/login' })).toMatchObject({
      action: 'allow'
    })
    expect(childWindowOpenHandler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-1',
      origin: 'null',
      action: 'blocked'
    })
    browserManager.notifyPermissionDenied({
      guestWebContentsId: childGuest.id,
      permission: 'notifications',
      rawUrl: 'https://identity.example.com/login'
    })
    expect(rendererSendMock).toHaveBeenCalledWith('browser:permission-denied', {
      browserPageId: 'browser-1',
      permission: 'notifications',
      origin: 'https://identity.example.com'
    })

    const childDidFailLoadHandler = childOnMock.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as
      | ((
          event: Electron.Event,
          errorCode: number,
          errorDescription: string,
          validatedURL: string,
          isMainFrame: boolean
        ) => void)
      | undefined
    childDidFailLoadHandler?.(
      {} as Electron.Event,
      -105,
      'Name not resolved',
      'https://identity.example.com/unavailable',
      true
    )
    expect(rendererSendMock).not.toHaveBeenCalledWith(
      'browser:guest-load-failed',
      expect.anything()
    )

    const childDownloadItem = createDownloadItem()
    browserManager.handleGuestWillDownload({
      guestWebContentsId: childGuest.id,
      item: childDownloadItem
    })
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-requested',
      expect.objectContaining({ browserPageId: 'browser-1' })
    )
    const childDownloadDoneHandler = getDownloadItemEventHandler(childDownloadItem, 'once', 'done')
    childDownloadDoneHandler?.({} as Electron.Event, 'completed')

    const managerState = browserManager as unknown as {
      popupOwnerContextByGuestId: Map<number, unknown>
    }
    expect(managerState.popupOwnerContextByGuestId.has(childGuest.id)).toBe(true)

    const cleanupChildOnMock = vi.fn()
    const cleanupChildGuest = {
      ...childGuest,
      id: 4041,
      on: cleanupChildOnMock,
      off: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
    const childDidCreateWindowHandler = childOnMock.mock.calls.find(
      ([event]) => event === 'did-create-window'
    )?.[1] as ((window: { webContents: typeof cleanupChildGuest }) => void) | undefined
    childDidCreateWindowHandler?.({ webContents: cleanupChildGuest })
    expect(managerState.popupOwnerContextByGuestId.has(cleanupChildGuest.id)).toBe(true)
    const cleanupChildWindowOpenHandler = cleanupChildGuest.setWindowOpenHandler.mock
      .calls[0][0] as (details: { url: string }) => { action: 'allow' | 'deny' }
    expect(
      cleanupChildWindowOpenHandler({ url: 'https://identity.example.com/continue' })
    ).toMatchObject({ action: 'allow' })
    const cleanupChildDestroyedHandler = cleanupChildOnMock.mock.calls.find(
      ([event]) => event === 'destroyed'
    )?.[1] as (() => void) | undefined
    cleanupChildDestroyedHandler?.()
    expect(managerState.popupOwnerContextByGuestId.has(cleanupChildGuest.id)).toBe(false)

    const replacementGuest = {
      ...guest,
      id: 405,
      on: vi.fn(),
      off: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === replacementGuest.id) {
        return replacementGuest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })
    browserManager.attachGuestPolicies(replacementGuest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: replacementGuest.id,
      rendererWebContentsId
    })

    expect(childWindowOpenHandler({ url: 'https://identity.example.com/next' })).toEqual({
      action: 'deny'
    })
    expect(shellOpenExternalMock).toHaveBeenCalledWith('https://identity.example.com/next')
    expect(managerState.popupOwnerContextByGuestId.has(childGuest.id)).toBe(false)

    const childDestroyedHandler = childOnMock.mock.calls.find(
      ([event]) => event === 'destroyed'
    )?.[1] as (() => void) | undefined
    childDestroyedHandler?.()
    expect(managerState.popupOwnerContextByGuestId.has(childGuest.id)).toBe(false)

    browserManager.unregisterAll()

    expect(childOffMock).toHaveBeenCalledWith('did-create-window', expect.any(Function))
    expect(childOffMock).toHaveBeenCalledWith('will-navigate', expect.any(Function))
    expect(childOffMock).toHaveBeenCalledWith('will-redirect', expect.any(Function))
  })
})
