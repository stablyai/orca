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

vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

vi.mock('./browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({
    mode: browserMocks.processUserAgentMode,
    userAgent: browserMocks.processUserAgent
  })
}))

import { browserManager } from './browser-manager'
import { googleAuthUserAgent } from './browser-google-auth-ua'
import {
  guestBaseUserAgent,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'
import {
  createViewportGuestFactory,
  flushViewportOps,
  GUEST_CLEAN_UA
} from './browser-manager-viewport-test-fixtures'

const {
  guestOffMock,
  guestOnMock,
  guestSetBackgroundThrottlingMock,
  guestSetWindowOpenHandlerMock,
  guestOpenDevToolsMock,
  webContentsFromIdMock
} = browserMocks
const makeViewportGuest = createViewportGuestFactory(browserMocks)

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

  it('presents the Firefox UA on Google auth hosts and restores the base UA off them', async () => {
    let currentUa = guestBaseUserAgent
    const sendCommand = vi.fn().mockResolvedValue(undefined)
    const setUserAgent = vi.fn((ua: string) => {
      currentUa = ua
    })
    const guest = {
      id: 408,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://accounts.google.com/'),
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

    // The session UA remains authoritative while WebContents still presents Firefox.
    sendCommand.mockClear()
    willRedirect(null, 'https://myaccount.google.com/', false, true)
    const uaOverrideIndex = sendCommand.mock.calls.findIndex(
      ([method]) => method === 'Emulation.setUserAgentOverride'
    )
    await expect(sendCommand.mock.results[uaOverrideIndex]?.value).resolves.toBeUndefined()
    expect(sendCommand.mock.calls[uaOverrideIndex]).toEqual([
      'Emulation.setUserAgentOverride',
      { userAgent: guestBaseUserAgent }
    ])

    // Direct navigation can restore the WebContents UA and clear the temporary CDP override.
    setUserAgent.mockClear()
    sendCommand.mockClear()
    didStartNavigation(null, 'https://example.com/', false, true)
    expect(setUserAgent).toHaveBeenCalledOnce()
    expect(setUserAgent).toHaveBeenLastCalledWith(guestBaseUserAgent)
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', { userAgent: '' })
    await expect(sendCommand.mock.results.at(-1)?.value).resolves.toBeUndefined()

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
      userAgent: googleAuthUserAgent()
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
      userAgent: googleAuthUserAgent()
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
      userAgent: googleAuthUserAgent()
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
  it('leaves a redirect alone when no debugger is attached to write the UA', () => {
    const guest = {
      id: 419,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://mail.google.com/'),
      getUserAgent: vi.fn(() => guestBaseUserAgent),
      setUserAgent: vi.fn(),
      debugger: { isAttached: vi.fn(() => false), sendCommand: vi.fn() },
      session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-redirect-no-debugger',
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
  })

  // Direct navigation permits setUserAgent before request dispatch.
  it('still uses the WebContents UA write for navigations that are not redirects', () => {
    const guest = {
      id: 420,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://example.com/'),
      getUserAgent: vi.fn(() => guestBaseUserAgent),
      setUserAgent: vi.fn(),
      debugger: { isAttached: vi.fn(() => true), sendCommand: vi.fn(async () => undefined) },
      session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-direct-ua',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

    didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)

    expect(guest.setUserAgent).toHaveBeenLastCalledWith(googleAuthUserAgent())
    expect(guest.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Emulation.setUserAgentOverride',
      expect.anything()
    )
  })

  // Keep the process UA override until direct navigation can replace the stale Firefox base UA.
  it('never clears the override onto a stale Firefox WebContents UA and heals it on the next navigation', async () => {
    browserMocks.processUserAgent = GUEST_CLEAN_UA
    const { guest, debuggerSendCommand, presentedUserAgent, standingUserAgentOverride } =
      makeViewportGuest(9001)
    webContentsFromIdMock.mockReturnValue(guest)
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'tab-auth-then-preset',
      webContentsId: guest.id as number,
      rendererWebContentsId
    })
    await browserManager.setViewportOverride('tab-auth-then-preset', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    })
    await flushViewportOps()

    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    const willRedirect = guestOnMock.mock.calls.find(
      ([event]) => event === 'will-redirect'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

    didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
    await flushViewportOps()
    expect((guest.getUserAgent as () => string)()).toBe(googleAuthUserAgent())

    debuggerSendCommand.mockClear()
    willRedirect({ preventDefault: vi.fn() }, 'https://myaccount.google.com/', false, true)
    await flushViewportOps()
    expect(debuggerSendCommand).toHaveBeenLastCalledWith('Emulation.setUserAgentOverride', {
      userAgent: GUEST_CLEAN_UA
    })
    expect(presentedUserAgent()).toBe(GUEST_CLEAN_UA)

    debuggerSendCommand.mockClear()
    didStartNavigation(null, 'https://github.com/', false, true)
    await flushViewportOps()
    expect(debuggerSendCommand).toHaveBeenLastCalledWith('Emulation.setUserAgentOverride', {
      userAgent: ''
    })
    expect(standingUserAgentOverride()).toBeNull()
    expect(presentedUserAgent()).toBe(GUEST_CLEAN_UA)
  })
})
