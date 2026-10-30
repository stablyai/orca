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

let didCreateWindow: (window: { webContents: unknown }) => void = () => {}
const fakeGuest = (id: number) => ({
  id,
  isDestroyed: vi.fn(() => false),
  isCurrentlyAudible: vi.fn(() => false),
  getType: vi.fn(() => 'webview'),
  setWindowOpenHandler: vi.fn(),
  downloadURL: vi.fn(),
  on: vi.fn((event: string, listener: (window: { webContents: unknown }) => void) => {
    if (event === 'did-create-window') {
      didCreateWindow = listener
    }
  }),
  off: vi.fn(),
  once: vi.fn((_event: string, listener: () => void) => listener()),
  close: vi.fn()
})

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
      isCurrentlyAudible: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: childSetBackgroundThrottlingMock,
      setWindowOpenHandler: childSetWindowOpenHandlerMock,
      on: childOnMock,
      off: childOffMock,
      openDevTools: childOpenDevToolsMock,
      getURL: vi.fn(() => 'https://identity.example.com/login')
    }
    const guest = {
      id: 404,
      isDestroyed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
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

    expect(childSetBackgroundThrottlingMock).not.toHaveBeenCalled()
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

  it('exposes a live popup child as a page owned by its opener tab', async () => {
    const opener = fakeGuest(404)
    const popup = fakeGuest(4040)
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === opener.id ? opener : id === popup.id ? popup : null
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the policy reads only the fake's listed members.
    browserManager.attachGuestPolicies(opener as unknown as Electron.WebContents)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      worktreeId: 'wt-1',
      sessionProfileId: 'work',
      webContentsId: opener.id,
      rendererWebContentsId
    })
    didCreateWindow({ webContents: popup })

    expect(browserManager.getPopupPages()).toEqual([
      { browserPageId: 'popup-4040', webContentsId: 4040, openerBrowserPageId: 'browser-1' }
    ])
    expect(browserManager.getWorktreeIdForTab('popup-4040')).toBe('wt-1')
    expect(browserManager.getSessionProfileIdForTab('popup-4040')).toBe('work')
    await expect(browserManager.closePopupPage('browser-1')).resolves.toBe(false)
    await expect(browserManager.closePopupPage('popup-4040')).resolves.toBe(true)
    expect(popup.close).toHaveBeenCalledTimes(1)

    browserManager.unregisterGuest('browser-1')
    expect(browserManager.getPopupPages()).toEqual([])
  })

  it("saves a popup page's agent download to its path and refuses a second claim on the tab", async () => {
    const opener = fakeGuest(406)
    const popup = fakeGuest(4060)
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === opener.id ? opener : id === popup.id ? popup : null
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the policy reads only the fake's listed members.
    browserManager.attachGuestPolicies(opener as unknown as Electron.WebContents)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: opener.id,
      rendererWebContentsId
    })
    didCreateWindow({ webContents: popup })

    const claim = browserManager.claimNextDownload(popup.id, '/work/out/receipt.pdf')
    expect(() => browserManager.claimNextDownload(opener.id, '/work/out/other.pdf')).toThrow(
      'Another download is already waiting'
    )
    const item = createDownloadItem()
    browserManager.handleGuestWillDownload({ guestWebContentsId: popup.id, item })

    expect(item.setSavePath).toHaveBeenCalledWith('/work/out/receipt.pdf')
    await expect(claim.started).resolves.toBe(true)
  })

  it("opens a sibling popup's new-tab link as a tab while its tab waits for a download", () => {
    const rendererSend = vi.fn()
    const opener = fakeGuest(407)
    const popup = fakeGuest(4070)
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSend }
      }
      return id === opener.id ? opener : id === popup.id ? popup : null
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the policy reads only the fake's listed members.
    browserManager.attachGuestPolicies(opener as unknown as Electron.WebContents)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: opener.id,
      rendererWebContentsId
    })
    didCreateWindow({ webContents: popup })
    const openFromPopup = popup.setWindowOpenHandler.mock.calls[0][0]

    browserManager.claimNextDownload(opener.id, '/work/out/report.csv')
    openFromPopup({
      url: 'https://app.example.com/help',
      frameName: '',
      features: '',
      disposition: 'foreground-tab'
    })

    expect(popup.downloadURL).not.toHaveBeenCalled()
    expect(rendererSend).toHaveBeenCalledWith('browser:open-link-in-orca-tab', {
      browserPageId: 'browser-1',
      url: 'https://app.example.com/help'
    })
  })
})
