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

vi.mock('../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

vi.mock('../../../identity/browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({
    mode: 'clean',
    userAgent: 'Mozilla/5.0 (Test) Chrome/140.0.0.0'
  })
}))

import { browserManager } from '../browser-manager'
import {
  guestUaMethods,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from '../browser-manager-test-harness'

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

  it('restores a certificate failure when a retry navigation aborts before committing', () => {
    const guest = {
      id: 406,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      isCurrentlyAudible: vi.fn(() => false),
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
    didStartNavigation(null, 'https://localhost:3443/', false, true)
    expect(browserManager.getBrowserPageLoadError('browser-retry-abort-page')).toBeNull()
    didFailLoad(null, -3, 'Aborted', 'https://localhost:3443/', true)
    expect(browserManager.getBrowserPageLoadError('browser-retry-abort-page')?.code).toBe(-202)

    // A fresh navigation must discard the stash so a later abort cannot resurrect stale errors.
    didStartNavigation(null, 'https://localhost:3443/', false, true)
    didStartNavigation(null, 'https://example.com/', false, true)
    didFailLoad(null, -3, 'Aborted', 'https://example.com/', true)
    expect(browserManager.getBrowserPageLoadError('browser-retry-abort-page')).toBeNull()
  })
})
