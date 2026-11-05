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
  openPopupWithOriginBarMock: vi.fn(),
  processUserAgentMode: 'clean',
  processUserAgent: 'Mozilla/5.0 (Test) Chrome/140.0.0.0'
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

vi.mock('../popups/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

vi.mock('../../identity/browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({
    mode: browserMocks.processUserAgentMode,
    userAgent: browserMocks.processUserAgent,
    electronUserAgent:
      browserMocks.processUserAgentMode === 'native'
        ? browserMocks.processUserAgent
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/134.0.0.0 Electron/30.0.0 Safari/537.36'
  })
}))

import { browserManager } from '../../browser-manager'
import { googleAuthUserAgent } from '../../identity/browser-google-auth-ua'
import {
  guestBaseUserAgent,
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
    browserMocks.processUserAgentMode = 'clean'
    browserMocks.processUserAgent = guestBaseUserAgent
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('presents the Electron UA on Google auth hosts and restores the base UA off them', async () => {
    let currentUa = guestBaseUserAgent
    let committedUrl = 'https://accounts.google.com/'
    const sendCommand = vi.fn().mockResolvedValue(undefined)
    const setUserAgent = vi.fn((ua: string) => {
      currentUa = ua
    })
    const guest = {
      id: 408,
      isDestroyed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => committedUrl),
      getUserAgent: vi.fn(() => currentUa),
      setUserAgent,
      debugger: { isAttached: vi.fn(() => true), sendCommand },
      session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-auth-ua',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    const willRedirect = guestOnMock.mock.calls.find(
      ([event]) => event === 'will-redirect'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    setUserAgent.mockClear()

    didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
    expect(setUserAgent).toHaveBeenLastCalledWith(googleAuthUserAgent())

    // A UA-only CDP override would blank client hints on the landing page; the document keeps the
    // auth WebContents UA and the request hook presents the profile identity.
    sendCommand.mockClear()
    willRedirect(null, 'https://myaccount.google.com/', false, true)
    expect(sendCommand).not.toHaveBeenCalledWith(
      'Emulation.setUserAgentOverride',
      expect.anything()
    )
    expect(setUserAgent).toHaveBeenCalledOnce()
    const landingRequest = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads no Session member.
      session: guest.session as unknown as Electron.Session,
      webContentsId: guest.id,
      currentUserAgent: googleAuthUserAgent(),
      effectiveUserAgent: googleAuthUserAgent()
    }
    expect(
      browserManager.resolveBrowserGuestRequestUserAgent({
        ...landingRequest,
        url: 'https://myaccount.google.com/'
      })
    ).toEqual({ kind: 'process', userAgent: guestBaseUserAgent })
    const didNavigate = guestOnMock.mock.calls.find(([event]) => event === 'did-navigate')?.[1] as (
      event: unknown,
      url: string
    ) => void
    committedUrl = 'https://myaccount.google.com/'
    didNavigate(null, committedUrl)
    expect(
      browserManager.resolveBrowserGuestRequestUserAgent({
        ...landingRequest,
        url: 'https://myaccount.google.com/_/data',
        resourceType: 'xhr'
      })
    ).toEqual({ kind: 'process', userAgent: guestBaseUserAgent })

    // The next navigation start restores the WebContents UA; nothing on CDP needs clearing.
    setUserAgent.mockClear()
    didStartNavigation(null, 'https://example.com/', false, true)
    expect(setUserAgent).toHaveBeenCalledOnce()
    expect(setUserAgent).toHaveBeenLastCalledWith(guestBaseUserAgent)
    expect(sendCommand).not.toHaveBeenCalled()

    setUserAgent.mockClear()
    sendCommand.mockClear()
    didStartNavigation(null, 'https://example.org/', false, true)
    expect(setUserAgent).not.toHaveBeenCalled()
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('leaves the UA untouched on Google auth hosts in native process mode', () => {
    browserMocks.processUserAgentMode = 'native'
    const setUserAgent = vi.fn()
    const guest = {
      id: 409,
      isDestroyed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://accounts.google.com/'),
      getUserAgent: vi.fn(() => guestBaseUserAgent),
      setUserAgent,
      session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-native-ua',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    setUserAgent.mockClear()

    didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
    expect(setUserAgent).not.toHaveBeenCalled()
  })

  // setUserAgent during will-redirect can abort and replay the request, breaking sign-in POST flows;
  // a UA-only CDP override would blank client hints. The request hook presents the auth UA instead.
  it.each([true, false])(
    'leaves the tab UA alone on a redirect onto a Google auth host (debugger attached=%s)',
    (debuggerAttached) => {
      const guest = {
        id: debuggerAttached ? 418 : 419,
        isDestroyed: vi.fn(() => false),
        isCurrentlyAudible: vi.fn(() => false),
        send: vi.fn(),
        getType: vi.fn(() => 'webview'),
        setBackgroundThrottling: guestSetBackgroundThrottlingMock,
        setWindowOpenHandler: guestSetWindowOpenHandlerMock,
        on: guestOnMock,
        off: guestOffMock,
        openDevTools: guestOpenDevToolsMock,
        getURL: vi.fn(() => 'https://mail.google.com/'),
        getUserAgent: vi.fn(() => guestBaseUserAgent),
        setUserAgent: vi.fn(),
        debugger: {
          isAttached: vi.fn(() => debuggerAttached),
          sendCommand: vi.fn().mockResolvedValue(undefined)
        },
        session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
      }
      webContentsFromIdMock.mockReturnValue(guest)

      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: `browser-redirect-onto-auth-${debuggerAttached}`,
        webContentsId: guest.id,
        rendererWebContentsId
      })
      const willRedirect = guestOnMock.mock.calls.find(
        ([event]) => event === 'will-redirect'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      willRedirect(
        { preventDefault: vi.fn() },
        'https://accounts.google.com/v3/signin/identifier',
        false,
        true
      )

      expect(guest.setUserAgent).not.toHaveBeenCalled()
      expect(guest.debugger.sendCommand).not.toHaveBeenCalledWith(
        'Emulation.setUserAgentOverride',
        expect.anything()
      )
    }
  )
})
