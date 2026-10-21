import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    prependOnceListener: vi.fn(),
    off: vi.fn(),
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
import { respondToBrowserPagePrompt } from './browser-page-prompts'
import { handleBrowserGuestLogin } from './browser-http-auth-prompt'
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
  webContentsFromIdMock,
  shellOpenExternalMock
} = browserMocks

describe('browserManager page prompt routing', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  it('asks before a page hands a link to another app, naming the frame that asked', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 107,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      getURL: vi.fn(() => 'https://trusted.example/home'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      prependListener: vi.fn(),
      once: vi.fn(),
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const renderer = {
      id: rendererWebContentsId,
      isDestroyed: () => false,
      send: rendererSendMock,
      on: vi.fn(),
      off: vi.fn()
    }
    shellOpenExternalMock.mockResolvedValue(undefined)
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === guest.id ? guest : id === rendererWebContentsId ? renderer : null
    )
    browserManager.attachGuestPolicies(webContentsFromIdMock(guest.id))
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    const prompts = (): { requestId: string; scheme: string; origin: string | null }[] =>
      rendererSendMock.mock.calls
        .filter(([channel]) => channel === 'browser:page-prompt-requested')
        .map(([, request]) => ({ requestId: request.requestId, ...request.details }))
    const answerLatest = (open: boolean): void => {
      void respondToBrowserPagePrompt(webContentsFromIdMock(rendererWebContentsId), {
        requestId: prompts().at(-1)!.requestId,
        answer: open ? true : null
      })
    }
    const untrustedFrame = { url: 'https://untrusted.example/ad', isDestroyed: () => false }
    // After a Cancel the page stays quiet until the user clicks in it again.
    const clickInPage = (): void => {
      for (const [event, listener] of guestOnMock.mock.calls) {
        if (event === 'input-event') {
          listener({}, { type: 'mouseDown' })
        }
      }
    }

    const windowOpenHandler = guestSetWindowOpenHandlerMock.mock.calls[0][0]
    expect(
      windowOpenHandler({
        url: 'mailto:help@example.com',
        referrer: { url: untrustedFrame.url, policy: 'default' }
      })
    ).toEqual({ action: 'deny' })
    expect(prompts().at(-1)).toMatchObject({
      scheme: 'mailto',
      origin: 'https://untrusted.example'
    })
    expect(rendererSendMock).not.toHaveBeenCalledWith('browser:popup', expect.anything())
    answerLatest(false)
    clickInPage()
    // A page that withholds its referrer is not credited to the top page.
    windowOpenHandler({
      url: 'mailto:help@example.com',
      referrer: { url: '', policy: 'no-referrer' }
    })
    expect(prompts().at(-1)).toMatchObject({ origin: null })
    answerLatest(false)
    clickInPage()
    expect(shellOpenExternalMock).not.toHaveBeenCalled()

    const willNavigate = guestOnMock.mock.calls.find(([event]) => event === 'will-navigate')?.[1]
    const preventDefault = vi.fn()
    willNavigate({ preventDefault, initiator: untrustedFrame }, 'zoommtg://zoom.us/join?confno=1')
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(prompts().at(-1)).toMatchObject({
      scheme: 'zoommtg',
      origin: 'https://untrusted.example'
    })
    answerLatest(true)
    expect(shellOpenExternalMock).toHaveBeenCalledWith('zoommtg://zoom.us/join?confno=1')
    willNavigate({ preventDefault, initiator: null }, 'zoommtg://zoom.us/join?confno=2')
    expect(prompts().at(-1)).toMatchObject({ origin: null })
    answerLatest(false)
  })

  it('closes an open prompt when its page is closed', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 108,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      prependListener: vi.fn(),
      once: vi.fn(),
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const renderer = {
      id: rendererWebContentsId,
      isDestroyed: () => false,
      send: rendererSendMock,
      on: vi.fn(),
      off: vi.fn()
    }
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === guest.id ? guest : id === rendererWebContentsId ? renderer : null
    )
    browserManager.attachGuestPolicies(webContentsFromIdMock(guest.id))
    browserManager.registerGuest({
      browserPageId: 'browser-2',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    const willNavigate = guestOnMock.mock.calls.find(([event]) => event === 'will-navigate')?.[1]
    willNavigate({ preventDefault: vi.fn(), initiator: null }, 'zoommtg://zoom.us/join?confno=1')
    const requestId = rendererSendMock.mock.calls.find(
      ([channel]) => channel === 'browser:page-prompt-requested'
    )?.[1].requestId
    expect(requestId).toEqual(expect.any(String))

    browserManager.unregisterGuest('browser-2')

    expect(rendererSendMock).toHaveBeenCalledWith('browser:page-prompt-closed', {
      requestId
    })
  })

  it("asks for a new tab's first sign-in once its window registers the tab", async () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 109,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      getURL: vi.fn(() => ''),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      prependListener: vi.fn(),
      once: vi.fn(),
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const renderer = {
      id: rendererWebContentsId,
      isDestroyed: () => false,
      send: rendererSendMock,
      on: vi.fn(),
      off: vi.fn()
    }
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === guest.id ? guest : id === rendererWebContentsId ? renderer : null
    )
    // The webview attaches and starts loading before the renderer registers it.
    browserManager.attachGuestPolicies(webContentsFromIdMock(guest.id))
    const event = { preventDefault: vi.fn() }
    const callback = vi.fn()
    handleBrowserGuestLogin(
      event,
      webContentsFromIdMock(guest.id),
      {
        url: 'https://staging.acme.com/',
        pid: 1,
        isRequestForNavigation: true,
        firstAuthAttempt: true
      },
      { isProxy: false, scheme: 'basic', host: 'staging.acme.com', port: 443, realm: 'Staging' },
      callback
    )
    // Electron must not cancel the challenge while the tab has no window to ask in yet.
    expect(event.preventDefault).toHaveBeenCalled()
    expect(rendererSendMock).not.toHaveBeenCalledWith(
      'browser:page-prompt-requested',
      expect.anything()
    )

    browserManager.registerGuest({
      browserPageId: 'browser-3',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const request = rendererSendMock.mock.calls.find(
      ([channel]) => channel === 'browser:page-prompt-requested'
    )?.[1]
    expect(request).toMatchObject({
      kind: 'http-auth',
      details: { origin: 'https://staging.acme.com' }
    })
    await respondToBrowserPagePrompt(webContentsFromIdMock(rendererWebContentsId), {
      requestId: request.requestId,
      answer: { username: 'qa', password: 'hunter2' }
    })
    expect(callback).toHaveBeenCalledWith('qa', 'hunter2')
  })
})
