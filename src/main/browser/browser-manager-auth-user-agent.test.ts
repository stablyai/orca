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
import { googleAuthUserAgent } from './browser-google-auth-ua'
import { setBrowserSessionUserAgentMode } from './browser-session-user-agent-mode'
import {
  guestBaseUserAgent,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'
import {
  createViewportGuestFactory,
  flushViewportOps,
  GUEST_CLEAN_UA,
  GUEST_ELECTRON_UA
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
const MOBILE_VIEWPORT_OVERRIDE = {
  width: 375,
  height: 667,
  deviceScaleFactor: 2,
  mobile: true
} as const

describe('browserManager', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves request identity from the guest viewport and auth state', async () => {
    const { guest } = makeViewportGuest(4245)
    webContentsFromIdMock.mockReturnValue(guest)
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'tab-request-identity',
      webContentsId: guest.id as number,
      rendererWebContentsId
    })

    // Ablation: with no mobile preset, the clean session identity is resolved.
    expect(
      browserManager.resolveBrowserGuestRequestUserAgent({
        session: guest.session as Electron.Session,
        url: 'https://example.com/logo.png',
        webContentsId: guest.id as number,
        currentUserAgent: GUEST_CLEAN_UA,
        baseUserAgent: GUEST_ELECTRON_UA
      })
    ).toEqual({ userAgent: GUEST_CLEAN_UA })

    await browserManager.setViewportOverride('tab-request-identity', MOBILE_VIEWPORT_OVERRIDE)
    await flushViewportOps()
    const mobile = browserManager.resolveBrowserGuestRequestUserAgent({
      session: guest.session as Electron.Session,
      url: 'https://example.com/logo.png',
      webContentsId: guest.id as number,
      currentUserAgent: GUEST_CLEAN_UA,
      baseUserAgent: GUEST_ELECTRON_UA
    })
    expect(mobile.userAgent).toContain('CriOS/134')
    expect(mobile.userAgent).toContain('iPhone')
    expect(mobile.userAgentMetadata).toMatchObject({
      mobile: true,
      platform: 'iOS',
      model: 'iPhone'
    })

    // A service-worker request has no webContentsId; the Session is its only surviving owner.
    const workerMobile = browserManager.resolveBrowserGuestRequestUserAgent({
      session: guest.session as Electron.Session,
      url: 'https://example.com/worker-beacon',
      baseUserAgent: GUEST_ELECTRON_UA
    })
    expect(workerMobile.userAgent).toBe(mobile.userAgent)
    expect(workerMobile.userAgentMetadata).toEqual(mobile.userAgentMetadata)

    // Negative control: auth-document fan-out remains Firefox even while mobile emulation is active.
    expect(
      browserManager.resolveBrowserGuestRequestUserAgent({
        session: guest.session as Electron.Session,
        url: 'https://www.gstatic.com/_/signin/log',
        webContentsId: guest.id as number,
        currentUserAgent: GUEST_ELECTRON_UA,
        effectiveUserAgent: googleAuthUserAgent(),
        baseUserAgent: GUEST_ELECTRON_UA
      })
    ).toEqual({ userAgent: googleAuthUserAgent() })

    await browserManager.setViewportOverride('tab-request-identity', null)
    expect(
      browserManager.resolveBrowserGuestRequestUserAgent({
        session: guest.session as Electron.Session,
        url: 'https://example.com/worker-beacon',
        baseUserAgent: GUEST_ELECTRON_UA
      })
    ).toEqual({ userAgent: GUEST_CLEAN_UA })

    await browserManager.setViewportOverride('tab-request-identity', MOBILE_VIEWPORT_OVERRIDE)
    browserManager.unregisterGuest('tab-request-identity')
    expect(
      browserManager.resolveBrowserGuestRequestUserAgent({
        session: guest.session as Electron.Session,
        url: 'https://example.com/worker-after-tab-close',
        baseUserAgent: GUEST_ELECTRON_UA
      })
    ).toEqual({ userAgent: GUEST_CLEAN_UA })
  })

  it('keeps an unscoped worker request on the desktop identity without a mobile preset', () => {
    const { guest } = makeViewportGuest(4246)
    expect(
      browserManager.resolveBrowserGuestRequestUserAgent({
        session: guest.session as Electron.Session,
        url: 'https://example.com/desktop-worker',
        baseUserAgent: GUEST_ELECTRON_UA
      })
    ).toEqual({ userAgent: GUEST_CLEAN_UA })
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

    // A redirect off the auth host must derive the CDP write from the session UA, not the stale
    // Firefox WebContents UA installed by the direct navigation.
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

    // A navigation that doesn't change the required UA must not thrash setUserAgent.
    setUserAgent.mockClear()
    didStartNavigation(null, 'https://example.com/', false, true)
    expect(setUserAgent).not.toHaveBeenCalled()
  })

  it('leaves the UA untouched on Google auth hosts for native-UA profiles', () => {
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
      rendererWebContentsId,
      userAgentMode: 'native'
    })
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    setUserAgent.mockClear()

    didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
    expect(setUserAgent).not.toHaveBeenCalled()
  })

  it('honors native session mode before the guest registration IPC arrives', () => {
    const nativeSession = { getUserAgent: vi.fn(() => guestBaseUserAgent) }
    setBrowserSessionUserAgentMode(nativeSession as never, 'native')
    const setUserAgent = vi.fn()
    const guest = {
      id: 417,
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
      session: nativeSession
    }

    browserManager.attachGuestPolicies(guest as never)
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

    didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
    expect(setUserAgent).not.toHaveBeenCalled()
  })

  // Why: popup child windows get attachGuestPolicies but are never entered into tabIdByWebContentsId,
  // so a direct lookup of the UA mode misses the native opt-out. That is worse than doing nothing —
  // native sessions skip setupGoogleAuthUserAgentOverride, so the popup would send the raw Electron UA on the
  // wire while navigator.userAgent claimed Firefox. Google sign-in popups are a first-class surface.
  it('leaves the UA untouched on auth hosts for a popup owned by a native-UA profile', () => {
    const ownerGuest = {
      id: 415,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://accounts.google.com/'),
      getUserAgent: vi.fn(() => guestBaseUserAgent),
      setUserAgent: vi.fn(),
      session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
    }
    webContentsFromIdMock.mockReturnValue(ownerGuest)
    browserManager.attachGuestPolicies(ownerGuest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-native-popup-owner',
      webContentsId: ownerGuest.id,
      rendererWebContentsId,
      userAgentMode: 'native'
    })

    // The popup carries its own listeners so its handler is unambiguous.
    const popupOn = vi.fn()
    const popupSetUserAgent = vi.fn()
    const popupGuest = {
      id: 416,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'window'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: popupOn,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://accounts.google.com/'),
      getUserAgent: vi.fn(() => guestBaseUserAgent),
      setUserAgent: popupSetUserAgent,
      session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
    }
    browserManager.attachGuestPolicies(popupGuest as never, {
      browserTabId: 'browser-native-popup-owner',
      rootGuestWebContentsId: ownerGuest.id
    })

    const popupDidStartNavigation = popupOn.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    expect(popupDidStartNavigation).toBeDefined()

    popupDidStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
    expect(popupSetUserAgent).not.toHaveBeenCalled()
  })

  // Why: WebContents.setUserAgent() from will-redirect makes Chromium cancel the in-flight navigation
  // (ERR_ABORTED) and replay the original request. A "Sign in with Google" button POSTs to the
  // provider and lands on accounts.google.com only by redirect, so the replay never reproduces it and
  // the tab is left blank. Verified against Electron 43.1.0: the server sees the original request twice.
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

    // A rejected write must not be recorded as installed; the next navigation retries it.
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

    // Detaching clears Chromium's CDP overrides, so the confirmed identity must be invalidated too.
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

    // Why: the CDP override outranks the WebContents UA, so getUserAgent() still reports the base
    // identity. Leaving the auth host must read the override, not that stale value, or the guest
    // keeps presenting Firefox on every later host.
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
      ['Emulation.setUserAgentOverride', { userAgent: guestBaseUserAgent }],
      ['Emulation.setUserAgentOverride', { userAgent: guestBaseUserAgent }]
    ])

    // A newer confirmed write outranks an older write that remains in flight.
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

    // A newer failure must not discard an older write that is still in flight.
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
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
      userAgent: guestBaseUserAgent
    })
    browserManager.unregisterGuest('browser-redirect-ua')
  })

  // Why: a redirect must never be cancelled to keep the identity in sync. Without a debugger there is
  // no cancel-free write available, and a stale navigator.userAgent is recoverable where a dead
  // navigation is not.
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

  // Why: a direct load reaches did-start-navigation before the request is dispatched, so the
  // WebContents write is safe there and must stay — CDP is the redirect-path mechanism only.
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

  // Why: the direct-navigation branch still writes the Firefox UA through WebContents.setUserAgent,
  // and nothing ever restores it once the guest switches to the CDP override. A viewport preset that
  // read getUserAgent() back as its base identity would therefore republish Firefox on every ordinary
  // host — the wire UA saying Firefox while sec-ch-ua still says Chrome, the exact cross-layer tell
  // this scope exists to remove.
  it('keeps a viewport preset on the session identity after an auth-host visit', async () => {
    const { guest, debuggerSendCommand } = makeViewportGuest(9001)
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
    // The direct branch pins the WebContents UA to Firefox and never restores it.
    expect((guest.getUserAgent as () => string)()).toBe(googleAuthUserAgent())

    willRedirect({ preventDefault: vi.fn() }, 'https://myaccount.google.com/', false, true)
    await flushViewportOps()

    debuggerSendCommand.mockClear()
    didStartNavigation(null, 'https://github.com/', false, true)
    await flushViewportOps()

    const uaWrites = debuggerSendCommand.mock.calls.filter(
      ([method]) => method === 'Emulation.setUserAgentOverride'
    )
    expect(uaWrites.length).toBeGreaterThan(0)
    for (const [, params] of uaWrites) {
      expect((params as { userAgent: string }).userAgent).toBe(GUEST_CLEAN_UA)
    }
  })
})
