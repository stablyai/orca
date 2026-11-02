import { beforeEach, describe, expect, it, vi } from 'vitest'

const browserMocks = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => '/downloads'),
  appPrependOnceListenerMock: vi.fn(),
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
    prependOnceListener: browserMocks.appPrependOnceListenerMock,
    off: vi.fn(),
    getPath: browserMocks.appGetPathMock
  },
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
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'

const {
  appPrependOnceListenerMock,
  guestOnMock,
  guestSetWindowOpenHandlerMock,
  webContentsFromIdMock,
  openPopupWithOriginBarMock
} = browserMocks

const OAUTH_URL =
  'https://accounts.example.com/authorize?client_id=synthetic&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback&response_type=code'

type WindowOpenHandler = (details: {
  url: string
  frameName: string
  features: string
  disposition: string
  postBody?: Electron.PostBody
}) => { action: 'allow' | 'deny'; createWindow?: (options: Record<string, unknown>) => unknown }

function popupContents(opener: Pick<Electron.WebFrameMain, 'frameTreeNodeId'> | null) {
  return {
    id: 2201,
    opener,
    session: guestSession,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
    setWindowOpenHandler: vi.fn()
  }
}

const guestSession = { marker: 'synthetic-opener-session' }
const rendererSendMock = vi.fn()

function attachClickedGuest(): WindowOpenHandler {
  const guest = {
    id: 2200,
    session: guestSession,
    isDestroyed: vi.fn(() => false),
    getType: vi.fn(() => 'webview'),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: guestSetWindowOpenHandlerMock,
    on: guestOnMock,
    once: vi.fn(),
    off: vi.fn(),
    openDevTools: vi.fn()
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
  const onInput = guestOnMock.mock.calls.find(([event]) => event === 'input-event')?.[1]
  onInput?.({}, { type: 'mouseDown' })
  const handler: WindowOpenHandler = guestSetWindowOpenHandlerMock.mock.calls[0][0]
  return handler
}

function routedTabs(): unknown[] {
  return rendererSendMock.mock.calls
    .filter(([channel]) => channel === 'browser:open-link-in-orca-tab')
    .map(([, payload]) => payload)
}

describe('tab-shaped OAuth opens without an opener', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
    appPrependOnceListenerMock.mockReset()
    rendererSendMock.mockReset()
    openPopupWithOriginBarMock.mockReturnValue({
      contentWebContents: popupContents(null),
      close: vi.fn(),
      onClosed: vi.fn()
    })
  })

  it('keeps a scripted OAuth window that has an opener as a popup', () => {
    const response = attachClickedGuest()({
      url: OAUTH_URL,
      frameName: '',
      features: '',
      disposition: 'foreground-tab'
    })
    const page = popupContents({ frameTreeNodeId: 1 })

    response.createWindow?.({ webContents: page })

    expect(routedTabs()).toEqual([])
    expect(page.close).not.toHaveBeenCalled()
    expect(openPopupWithOriginBarMock).toHaveBeenCalledWith(
      expect.objectContaining({ webContents: page }),
      OAUTH_URL,
      expect.any(Function)
    )
  })

  it('opens a plain OAuth link as a tab and ends its page before the first request', () => {
    const response = attachClickedGuest()({
      url: OAUTH_URL,
      frameName: '',
      features: '',
      disposition: 'foreground-tab'
    })
    const page = popupContents(null)

    expect(response.createWindow?.({ webContents: page })).toBe(page)

    expect(routedTabs()).toEqual([{ browserPageId: 'browser-1', url: OAUTH_URL }])
    expect(page.on).toHaveBeenCalledWith('will-navigate', expect.any(Function))
    expect(page.close).toHaveBeenCalledOnce()
    expect(openPopupWithOriginBarMock).not.toHaveBeenCalled()
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-1',
      origin: 'https://accounts.example.com',
      action: 'opened-in-orca'
    })
  })

  it('opens a Cmd/Ctrl+Shift-clicked OAuth link, which hands over no page, as a tab', () => {
    const response = attachClickedGuest()({
      url: OAUTH_URL,
      frameName: '',
      features: '',
      disposition: 'foreground-tab'
    })

    response.createWindow?.({})

    expect(routedTabs()).toEqual([{ browserPageId: 'browser-1', url: OAUTH_URL }])
    const prepare: () => boolean = openPopupWithOriginBarMock.mock.calls.at(-1)?.[2]
    expect(prepare()).toBe(false)
  })

  it('opens a Cmd/Ctrl-clicked OAuth link as a background tab instead of a native window', () => {
    const response = attachClickedGuest()({
      url: OAUTH_URL,
      frameName: '',
      features: '',
      disposition: 'background-tab'
    })
    expect(response).toMatchObject({ action: 'allow' })
    const onWindowCreated: (event: unknown, window: unknown) => void =
      appPrependOnceListenerMock.mock.calls.at(-1)?.[1]
    const nativeWindow = {
      webContents: popupContents(null),
      isDestroyed: vi.fn(() => false),
      destroy: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
      setTitle: vi.fn()
    }

    onWindowCreated({}, nativeWindow)

    expect(routedTabs()).toEqual([{ browserPageId: 'browser-1', url: OAUTH_URL, activate: false }])
    const [options, , prepare] = openPopupWithOriginBarMock.mock.calls.at(-1) ?? []
    expect(options).toMatchObject({ nativeWindow })
    expect(prepare()).toBe(false)
  })

  it('never turns a POST into a tab when no page was handed over', () => {
    const response = attachClickedGuest()({
      url: 'https://app.example.com/submit',
      frameName: '',
      features: '',
      disposition: 'foreground-tab',
      postBody: { contentType: 'application/x-www-form-urlencoded', data: [] }
    })

    response.createWindow?.({})

    expect(routedTabs()).toEqual([])
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-1',
      origin: 'https://app.example.com',
      action: 'blocked'
    })
  })
})
