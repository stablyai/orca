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
  guestUaMethods,
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

  it('tracks offscreen load failures for the owning worktree snapshot', () => {
    const stateChanged = vi.fn()
    const offscreenGuest = {
      id: 605,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'window'),
      setBackgroundThrottling: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      getURL: vi.fn(() => 'https://localhost:3443/')
    }
    webContentsFromIdMock.mockReturnValue(offscreenGuest)
    browserManager.setBrowserGuestStateChangedListener(stateChanged)

    browserManager.registerOffscreenGuest({
      browserPageId: 'offscreen-page',
      worktreeId: 'remote-worktree',
      webContentsId: offscreenGuest.id
    })
    const didFailLoad = offscreenGuest.on.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean
    ) => void
    didFailLoad(null, -202, 'Certificate authority invalid', 'https://localhost:3443/', true)

    expect(browserManager.getBrowserPageLoadError('offscreen-page')).toEqual({
      code: -202,
      description: 'Certificate authority invalid',
      validatedUrl: 'https://localhost:3443/'
    })
    expect(stateChanged).toHaveBeenCalledWith('remote-worktree')
  })

  it('replays a queued main-frame load failure after the guest registers', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 404,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'http://localhost:3000/'),
      ...guestUaMethods()
    }

    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === 404) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return {
          isDestroyed: vi.fn(() => false),
          send: rendererSendMock
        }
      }
      return null
    })

    browserManager.attachGuestPolicies(guest as never)

    const didFailLoadHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as
      | ((
          event: unknown,
          errorCode: number,
          errorDescription: string,
          validatedUrl: string,
          isMainFrame: boolean
        ) => void)
      | undefined

    expect(didFailLoadHandler).toBeTypeOf('function')
    didFailLoadHandler?.(null, -105, 'Name not resolved', 'http://localhost:3000/', true)

    expect(rendererSendMock).not.toHaveBeenCalled()

    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: 404,
      rendererWebContentsId
    })

    expect(rendererSendMock).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenCalledWith('browser:guest-load-failed', {
      browserPageId: 'browser-1',
      loadError: {
        code: -105,
        description: 'Name not resolved',
        validatedUrl: 'http://localhost:3000/'
      }
    })
    expect(browserManager.getBrowserPageLoadError('browser-1')).toEqual({
      code: -105,
      description: 'Name not resolved',
      validatedUrl: 'http://localhost:3000/'
    })

    const didStartNavigationHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as
      | ((event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void)
      | undefined
    didStartNavigationHandler?.(null, 'http://localhost:3000/retry', false, true)
    expect(browserManager.getBrowserPageLoadError('browser-1')).toBeNull()
  })

  it('drops a queued failure when a replacement navigation starts before registration', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 407,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://example.com/'),
      ...guestUaMethods()
    }
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === guest.id
        ? guest
        : id === rendererWebContentsId
          ? { isDestroyed: vi.fn(() => false), send: rendererSendMock }
          : null
    )

    browserManager.attachGuestPolicies(guest as never)
    const didFailLoad = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean
    ) => void
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

    didFailLoad(null, -202, 'Certificate authority invalid', 'https://localhost:3443/', true)
    didStartNavigation(null, 'https://example.com/', false, true)
    expect(
      browserManager.registerGuest({
        browserPageId: 'browser-late-registration',
        webContentsId: guest.id,
        rendererWebContentsId
      })
    ).toBe(true)

    expect(rendererSendMock).not.toHaveBeenCalledWith(
      'browser:guest-load-failed',
      expect.anything()
    )
    expect(browserManager.getBrowserPageLoadError('browser-late-registration')).toBeNull()
  })

  it('keeps a certificate failure until a real main-frame navigation starts', () => {
    const guest = {
      id: 405,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      send: vi.fn(),
      getURL: vi.fn(() => 'chrome-error://chromewebdata/'),
      ...guestUaMethods()
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    const didFailLoad = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean
    ) => void

    browserManager.registerGuest({
      browserPageId: 'browser-certificate-page',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    didFailLoad(null, -202, 'Certificate authority invalid', 'https://localhost:3443/', true)
    didStartNavigation(null, 'chrome-error://chromewebdata/', false, true)
    expect(browserManager.getBrowserPageLoadError('browser-certificate-page')?.code).toBe(-202)

    didStartNavigation(null, 'https://localhost:3443/', false, true)
    expect(browserManager.getBrowserPageLoadError('browser-certificate-page')).toBeNull()
  })

  it('restores a certificate failure when a retry navigation aborts before committing', () => {
    const guest = {
      id: 406,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      send: vi.fn(),
      getURL: vi.fn(() => 'chrome-error://chromewebdata/'),
      ...guestUaMethods()
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    const didFailLoad = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean
    ) => void

    browserManager.registerGuest({
      browserPageId: 'browser-retry-abort-page',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    didFailLoad(null, -202, 'Certificate authority invalid', 'https://localhost:3443/', true)
    // Retry: the new navigation starts (overlay optimistically cleared)...
    didStartNavigation(null, 'https://localhost:3443/', false, true)
    expect(browserManager.getBrowserPageLoadError('browser-retry-abort-page')).toBeNull()
    // ...then aborts (ERR_ABORTED) before committing, so the error is restored.
    didFailLoad(null, -3, 'Aborted', 'https://localhost:3443/', true)
    expect(browserManager.getBrowserPageLoadError('browser-retry-abort-page')?.code).toBe(-202)

    // A fresh navigation from a non-errored state drops the stash, so a later
    // abort cannot resurrect the old error.
    didStartNavigation(null, 'https://localhost:3443/', false, true) // stashes -202, clears active
    didStartNavigation(null, 'https://example.com/', false, true) // active empty -> drops stash
    didFailLoad(null, -3, 'Aborted', 'https://example.com/', true)
    expect(browserManager.getBrowserPageLoadError('browser-retry-abort-page')).toBeNull()
  })
})
