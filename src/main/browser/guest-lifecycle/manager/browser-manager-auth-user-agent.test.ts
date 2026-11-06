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

vi.mock('../../identity/browser-tab-identity', async (importOriginal) =>
  (
    await import('./browser-manager-desktop-ua-metadata-test-fixture')
  ).withPinnedDesktopUserAgentMetadata(await importOriginal<object>())
)

import { browserManager } from '../../browser-manager'
import { googleAuthUserAgent } from '../../identity/browser-google-auth-ua'
import {
  guestBaseUserAgent,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'
import { pinnedDesktopUserAgentMetadata as desktopMetadata } from './browser-manager-desktop-ua-metadata-test-fixture'

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

  // setUserAgent during will-redirect can abort and replay the request, breaking sign-in POST flows.
  it('retargets the auth-host UA over CDP during a redirect instead of cancelling it', async () => {
    const debuggerHandlers = new Map<string, () => void>()
    let holdNextUserAgentOverride = false
    let releaseHeldUserAgentOverride = (): void => {}
    let rejectNextUserAgentOverride = false
    const sendCommand = vi.fn((method: string) => {
      if (method === 'Emulation.setUserAgentOverride' && holdNextUserAgentOverride) {
        holdNextUserAgentOverride = false
        return new Promise<void>((resolve) => {
          releaseHeldUserAgentOverride = resolve
        })
      }
      if (method === 'Emulation.setUserAgentOverride' && rejectNextUserAgentOverride) {
        rejectNextUserAgentOverride = false
        return Promise.reject(new Error('debugger detached'))
      }
      return Promise.resolve(undefined)
    })
    const guest = {
      id: 418,
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
        isAttached: vi.fn(() => true),
        sendCommand,
        on: vi.fn((event: string, handler: () => void) => debuggerHandlers.set(event, handler)),
        off: vi.fn((event: string) => debuggerHandlers.delete(event))
      },
      session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-redirect-ua',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    const willRedirect = guestOnMock.mock.calls.find(
      ([event]) => event === 'will-redirect'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    sendCommand.mockClear()

    rejectNextUserAgentOverride = true
    willRedirect(
      { preventDefault: vi.fn() },
      'https://accounts.google.com/v3/signin/identifier',
      false,
      true
    )
    await expect(sendCommand.mock.results.at(-1)?.value).rejects.toThrow('debugger detached')

    // Failed writes must remain retryable.
    willRedirect(
      { preventDefault: vi.fn() },
      'https://accounts.google.com/v3/signin/identifier',
      false,
      true
    )
    await expect(sendCommand.mock.results.at(-1)?.value).resolves.toBeUndefined()

    expect(guest.setUserAgent).not.toHaveBeenCalled()
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
      userAgent: googleAuthUserAgent(),
      userAgentMetadata: desktopMetadata
    })

    // Detaching clears Chromium's CDP overrides and invalidates the confirmed identity.
    sendCommand.mockClear()
    debuggerHandlers.get('detach')?.()
    willRedirect(
      { preventDefault: vi.fn() },
      'https://accounts.google.com/v3/signin/identifier',
      false,
      true
    )
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
      userAgent: googleAuthUserAgent(),
      userAgentMetadata: desktopMetadata
    })

    // getUserAgent omits the CDP override; clear it on exit to restore UA and client hints.
    sendCommand.mockClear()
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    rejectNextUserAgentOverride = true
    didStartNavigation(null, 'https://example.com/', false, true)
    await expect(sendCommand.mock.results.at(-1)?.value).rejects.toThrow('debugger detached')
    didStartNavigation(null, 'https://example.com/', false, true)

    expect(guest.setUserAgent).not.toHaveBeenCalled()
    expect(sendCommand.mock.calls).toEqual([
      ['Emulation.setUserAgentOverride', { userAgent: '' }],
      ['Emulation.setUserAgentOverride', { userAgent: '' }]
    ])

    // Newer confirmed writes outrank older pending writes.
    debuggerHandlers.get('detach')?.()
    holdNextUserAgentOverride = true
    willRedirect(
      { preventDefault: vi.fn() },
      'https://accounts.google.com/v3/signin/identifier',
      false,
      true
    )
    const olderHeldWrite = sendCommand.mock.results.at(-1)?.value as Promise<void>
    didStartNavigation(null, 'https://example.com/', false, true)
    await expect(sendCommand.mock.results.at(-1)?.value).resolves.toBeUndefined()

    sendCommand.mockClear()
    willRedirect(
      { preventDefault: vi.fn() },
      'https://accounts.google.com/v3/signin/identifier',
      false,
      true
    )
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
      userAgent: googleAuthUserAgent(),
      userAgentMetadata: desktopMetadata
    })
    releaseHeldUserAgentOverride()
    await olderHeldWrite

    // A newer failure must preserve older pending writes.
    debuggerHandlers.get('detach')?.()
    holdNextUserAgentOverride = true
    willRedirect(
      { preventDefault: vi.fn() },
      'https://accounts.google.com/v3/signin/identifier',
      false,
      true
    )
    const heldWrite = sendCommand.mock.results.at(-1)?.value as Promise<void>
    rejectNextUserAgentOverride = true
    didStartNavigation(null, 'https://example.com/', false, true)
    await expect(sendCommand.mock.results.at(-1)?.value).rejects.toThrow('debugger detached')
    releaseHeldUserAgentOverride()
    await heldWrite

    sendCommand.mockClear()
    didStartNavigation(null, 'https://example.com/', false, true)
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', { userAgent: '' })
    browserManager.unregisterGuest('browser-redirect-ua')
  })

  // Prefer a stale UA to aborting the redirect when CDP is unavailable.

  // Direct navigation permits setUserAgent before request dispatch.

  // Keep the process UA override until direct navigation can replace the stale auth base UA.
})
