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
import {
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

const { guestOnMock, webContentsFromIdMock } = browserMocks
const makeGuest = createViewportGuestFactory(browserMocks)

describe('browserManager', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('setViewportOverride', () => {
    it('returns false when the tab is not registered', async () => {
      const result = await browserManager.setViewportOverride('missing', {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        mobile: true
      })
      expect(result).toBe(false)
    })

    it('applies device metrics, touch emulation, and a mobile UA for mobile presets', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4242)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-mobile',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      webContentsFromIdMock.mockReset()
      webContentsFromIdMock.mockReturnValue(guest)

      const ok = await browserManager.setViewportOverride('tab-mobile', {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        mobile: true
      })
      expect(ok).toBe(true)

      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        mobile: true
      })
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 5
      })
      const uaCall = debuggerSendCommand.mock.calls.find(
        (call) => call[0] === 'Emulation.setUserAgentOverride'
      )
      expect(uaCall).toBeDefined()
      expect(uaCall?.[1]).toMatchObject({
        userAgent: expect.stringContaining('iPhone')
      })
      // Chrome major from the guest UA should be spliced into the mobile UA.
      expect(uaCall?.[1]).toMatchObject({
        userAgent: expect.stringContaining('CriOS/134')
      })
    })

    it.each([false, true])(
      'keeps the session UA for native-mode profiles when mobile=%s',
      async (mobile) => {
        const { guest, debuggerSendCommand } = makeGuest(mobile ? 4244 : 4243)
        webContentsFromIdMock.mockReturnValue(guest)
        browserManager.attachGuestPolicies(guest as never)
        browserManager.registerGuest({
          browserPageId: `tab-native-${mobile}`,
          sessionProfileId: 'native-profile',
          userAgentMode: 'native',
          webContentsId: guest.id as number,
          rendererWebContentsId
        })

        await expect(
          browserManager.setViewportOverride(`tab-native-${mobile}`, {
            width: mobile ? 375 : 1024,
            height: mobile ? 667 : 768,
            deviceScaleFactor: mobile ? 2 : 1,
            mobile
          })
        ).resolves.toBe(true)

        expect(debuggerSendCommand).not.toHaveBeenCalledWith(
          'Emulation.setUserAgentOverride',
          expect.anything()
        )
      }
    )

    // Why: the CDP override outranks setUserAgent for navigator.userAgent, so a preset applied on an
    // auth host must carry the same Firefox identity the header hook sends (verified against real
    // Electron 43: Emulation.setUserAgentOverride wins over WebContents.setUserAgent and stands
    // across every later navigation until explicitly cleared).
    it.each([false, true])(
      'presents the Firefox UA for a preset applied on a Google auth host (mobile=%s)',
      async (mobile) => {
        const { guest, debuggerSendCommand } = makeGuest(
          mobile ? 4246 : 4245,
          'https://accounts.google.com/v3/signin/identifier'
        )
        webContentsFromIdMock.mockReturnValue(guest)
        browserManager.attachGuestPolicies(guest as never)
        browserManager.registerGuest({
          browserPageId: `tab-auth-${mobile}`,
          webContentsId: guest.id as number,
          rendererWebContentsId
        })

        await browserManager.setViewportOverride(`tab-auth-${mobile}`, {
          width: mobile ? 375 : 1024,
          height: mobile ? 667 : 768,
          deviceScaleFactor: mobile ? 2 : 1,
          mobile
        })

        expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
          userAgent: googleAuthUserAgent()
        })
      }
    )

    it('re-issues the standing UA override when navigating onto and back off an auth host', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4247)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-auth-nav',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      // Case A: the desktop preset lands first, while the tab is still off the auth host.
      await browserManager.setViewportOverride('tab-auth-nav', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      expect(debuggerSendCommand).toHaveBeenLastCalledWith('Emulation.setUserAgentOverride', {
        userAgent: GUEST_CLEAN_UA
      })

      // Navigating to the auth host must move the standing override to the Firefox identity.
      debuggerSendCommand.mockClear()
      didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
        userAgent: googleAuthUserAgent()
      })

      // Leaving the auth host restores the clean Chrome-shaped preset UA.
      debuggerSendCommand.mockClear()
      didStartNavigation(null, 'https://example.com/', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
        userAgent: GUEST_CLEAN_UA
      })
    })

    // Why: not an ordering race — debugger.sendCommand dispatches in call order over one channel, so
    // the later-issued write always wins. The defect is post-await staleness: verified against real
    // Electron 43.1.0, did-start-navigation fires while an awaited sendCommand is still pending, and
    // getURL() keeps reporting the OUTGOING page until commit. A preset resuming mid-navigation
    // therefore resolves the wrong host and wins with the wrong value. Both writers must resolve the
    // host from the in-flight navigation target instead.
    function lastUserAgentOverride(
      debuggerSendCommand: ReturnType<typeof vi.fn>
    ): Record<string, unknown> | undefined {
      const calls = debuggerSendCommand.mock.calls.filter(
        (call) => call[0] === 'Emulation.setUserAgentOverride'
      )
      return calls.at(-1)?.[1] as Record<string, unknown> | undefined
    }

    // Why mobile: on the desktop branch the break is masked by coincidence — applyGoogleAuthUserAgent
    // has already switched the WebContents UA to Firefox, and cleanElectronUserAgent passes a Firefox
    // UA through untouched, so the stale-URL desktop path happens to emit Firefox anyway. The mobile
    // branch derives a Chrome-shaped iPhone UA from that same base and exposes the real defect.
    it('does not leave the Chrome preset UA standing when a mobile preset lands mid-navigation onto an auth host', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4251, 'https://example.com/')
      // Hold the preset's first CDP command open so the navigation lands inside its await window.
      let releaseMetrics = (): void => {}
      const metricsGate = new Promise<void>((resolve) => {
        releaseMetrics = () => resolve()
      })
      debuggerSendCommand.mockImplementation((method: string) =>
        method === 'Emulation.setDeviceMetricsOverride' ? metricsGate : Promise.resolve(undefined)
      )
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-race-onto-auth',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      const presetDone = browserManager.setViewportOverride('tab-race-onto-auth', {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        mobile: true
      })
      await flushViewportOps()

      // The tab navigates to the auth host while the preset is still awaiting its first command.
      didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
      releaseMetrics()
      await presetDone
      await flushViewportOps()

      // Without a shared chain + shared URL source, the preset resumes, reads getURL() as the
      // pre-navigation host, and pins the tab to the Chrome-shaped UA while it is on the auth host.
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({
        userAgent: googleAuthUserAgent()
      })
    })

    it('does not leave the Firefox UA standing when a preset lands mid-navigation off an auth host', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4252, 'https://accounts.google.com/')
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-race-off-auth',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      // Establish a standing preset while the tab really is on the auth host.
      await browserManager.setViewportOverride('tab-race-off-auth', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await flushViewportOps()
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({
        userAgent: googleAuthUserAgent()
      })

      // A second preset change is now in flight when the tab leaves the auth host.
      let releaseMetrics = (): void => {}
      const metricsGate = new Promise<void>((resolve) => {
        releaseMetrics = () => resolve()
      })
      debuggerSendCommand.mockImplementation((method: string) =>
        method === 'Emulation.setDeviceMetricsOverride' ? metricsGate : Promise.resolve(undefined)
      )
      const presetDone = browserManager.setViewportOverride('tab-race-off-auth', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 2,
        mobile: false
      })
      await flushViewportOps()

      didStartNavigation(null, 'https://example.com/', false, true)
      releaseMetrics()
      await presetDone
      await flushViewportOps()

      // Without the fix the resuming preset re-reads getURL() as the auth host and clobbers the
      // navigation's correct write, stranding the Firefox UA on a non-auth page.
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({ userAgent: GUEST_CLEAN_UA })
    })

    it('falls back to the committed URL once a navigation commits or fails', async () => {
      const { guest, debuggerSendCommand, commitNavigationTo } = makeGuest(
        4253,
        'https://example.com/'
      )
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-pending-cleared',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
      const didFailLoad = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-fail-load'
      )?.[1] as (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ) => void
      const didNavigate = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-navigate'
      )?.[1] as (event: unknown, url: string) => void

      await browserManager.setViewportOverride('tab-pending-cleared', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await flushViewportOps()

      // An aborted navigation to the auth host must not leave that host standing as the tab's
      // identity: the tab never went there, so a later preset must resolve the committed URL.
      didStartNavigation(null, 'https://accounts.google.com/', false, true)
      didFailLoad(null, -3, 'Aborted', 'https://accounts.google.com/', true)
      await flushViewportOps()

      expect(guest.setUserAgent).toHaveBeenLastCalledWith(GUEST_ELECTRON_UA)
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({ userAgent: GUEST_CLEAN_UA })

      // A later preset must also resolve the committed, non-auth URL.
      debuggerSendCommand.mockClear()
      await browserManager.setViewportOverride('tab-pending-cleared', {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        mobile: true
      })
      await flushViewportOps()
      expect(lastUserAgentOverride(debuggerSendCommand)?.userAgent).toContain('iPhone')

      // Same after a successful commit: the committed URL takes over from the pending target.
      didStartNavigation(null, 'https://accounts.google.com/signin', false, true)
      commitNavigationTo('https://accounts.google.com/signin')
      didNavigate(null, 'https://accounts.google.com/signin')
      await flushViewportOps()

      debuggerSendCommand.mockClear()
      await browserManager.setViewportOverride('tab-pending-cleared', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await flushViewportOps()
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({
        userAgent: googleAuthUserAgent()
      })
    })

    it('does not let a superseded navigation failure revert a newer target', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4255, 'https://example.com/')
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-overlapping-navs',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
      const willRedirect = guestOnMock.mock.calls.find(
        ([event]) => event === 'will-redirect'
      )?.[1] as (
        event: { preventDefault: () => void },
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean
      ) => void
      const didFailLoad = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-fail-load'
      )?.[1] as (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ) => void

      await browserManager.setViewportOverride('tab-overlapping-navs', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      didStartNavigation(null, 'https://example.com/start', false, true)
      willRedirect({ preventDefault: vi.fn() }, 'https://accounts.google.com/same', false, true)
      didStartNavigation(null, 'https://accounts.google.com/same', false, true)
      await flushViewportOps()

      debuggerSendCommand.mockClear()
      didFailLoad(null, -3, 'Aborted', 'https://accounts.google.com/same', true)
      await flushViewportOps()

      expect(guest.setUserAgent).toHaveBeenLastCalledWith(googleAuthUserAgent())
      expect(debuggerSendCommand).not.toHaveBeenCalledWith(
        'Emulation.setUserAgentOverride',
        expect.objectContaining({ userAgent: GUEST_CLEAN_UA })
      )
    })

    it('switches identity for a server redirect and restores it if the redirect fails', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4256, 'https://example.com/')
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-auth-redirect',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
      const willRedirect = guestOnMock.mock.calls.find(
        ([event]) => event === 'will-redirect'
      )?.[1] as (
        event: { preventDefault: () => void },
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean
      ) => void
      const didFailLoad = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-fail-load'
      )?.[1] as (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ) => void

      await browserManager.setViewportOverride('tab-auth-redirect', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      didStartNavigation(null, 'https://example.com/start', false, true)
      willRedirect(
        { preventDefault: vi.fn() },
        'https://accounts.google.com/redirected',
        false,
        true
      )
      await flushViewportOps()

      expect(guest.setUserAgent).toHaveBeenLastCalledWith(googleAuthUserAgent())
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({
        userAgent: googleAuthUserAgent()
      })

      didFailLoad(null, -3, 'Aborted', 'https://accounts.google.com/redirected', true)
      await flushViewportOps()
      expect(guest.setUserAgent).toHaveBeenLastCalledWith(GUEST_ELECTRON_UA)
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({ userAgent: GUEST_CLEAN_UA })
    })

    it('reapplies a preset when navigation starts during its final UA write', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4257, 'https://example.com/')
      let releaseFirstUa = (): void => {}
      const firstUaGate = new Promise<void>((resolve) => {
        releaseFirstUa = resolve
      })
      let uaWrites = 0
      debuggerSendCommand.mockImplementation((method: string) => {
        if (method === 'Emulation.setUserAgentOverride' && uaWrites++ === 0) {
          return firstUaGate
        }
        return Promise.resolve(undefined)
      })
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-final-apply-race',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      const presetDone = browserManager.setViewportOverride('tab-final-apply-race', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await flushViewportOps()
      didStartNavigation(null, 'https://accounts.google.com/', false, true)
      await flushViewportOps()

      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({
        userAgent: googleAuthUserAgent()
      })
      releaseFirstUa()
      await presetDone
    })

    it('does not reinstall a preset while its final UA clear is in flight', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4258, 'https://example.com/')
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-final-clear-race',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      await browserManager.setViewportOverride('tab-final-clear-race', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      let releaseClearUa = (): void => {}
      const clearUaGate = new Promise<void>((resolve) => {
        releaseClearUa = resolve
      })
      debuggerSendCommand.mockImplementation(
        (method: string, params: { userAgent?: string } | undefined) =>
          method === 'Emulation.setUserAgentOverride' && params?.userAgent === ''
            ? clearUaGate
            : Promise.resolve(undefined)
      )
      const clearDone = browserManager.setViewportOverride('tab-final-clear-race', null)
      await flushViewportOps()

      debuggerSendCommand.mockClear()
      didStartNavigation(null, 'https://accounts.google.com/', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).not.toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
        userAgent: googleAuthUserAgent()
      })

      releaseClearUa()
      await clearDone
    })

    // Why: a failed clear leaves the CDP override standing on the target. Dropping the tracking entry
    // first makes it untracked, so the navigation path can never correct it again and the tab carries
    // a Chrome-shaped navigator.userAgent onto the auth hosts — the exact failure this PR prevents.
    it('keeps tracking the standing override when the CDP clear fails', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4254, 'https://example.com/')
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-failed-clear',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      await browserManager.setViewportOverride('tab-failed-clear', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await flushViewportOps()

      // The final UA clear fails after tracking was optimistically removed.
      debuggerSendCommand.mockImplementation(
        (method: string, params: { userAgent?: string } | undefined) =>
          method === 'Emulation.setUserAgentOverride' && params?.userAgent === ''
            ? Promise.reject(new Error('debugger detached'))
            : Promise.resolve(undefined)
      )
      await expect(browserManager.setViewportOverride('tab-failed-clear', null)).resolves.toBe(
        false
      )
      await flushViewportOps()

      // The override is still standing on the target, so navigation must still be able to correct it.
      debuggerSendCommand.mockImplementation(() => Promise.resolve(undefined))
      debuggerSendCommand.mockClear()
      didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
        userAgent: googleAuthUserAgent()
      })
    })

    it('does not touch the UA override on navigation when no preset is standing', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4248)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-no-preset',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      didStartNavigation(null, 'https://accounts.google.com/', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).not.toHaveBeenCalledWith(
        'Emulation.setUserAgentOverride',
        expect.anything()
      )
    })

    it('stops re-issuing the UA override once the preset is cleared', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4249)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-cleared-preset',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      await browserManager.setViewportOverride('tab-cleared-preset', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await browserManager.setViewportOverride('tab-cleared-preset', null)

      debuggerSendCommand.mockClear()
      didStartNavigation(null, 'https://accounts.google.com/', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).not.toHaveBeenCalledWith(
        'Emulation.setUserAgentOverride',
        expect.anything()
      )
    })

    it('leaves the UA override alone on navigation for native-UA profiles', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4250)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-native-nav',
        sessionProfileId: 'native-profile',
        userAgentMode: 'native',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      await browserManager.setViewportOverride('tab-native-nav', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      debuggerSendCommand.mockClear()
      didStartNavigation(null, 'https://accounts.google.com/', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).not.toHaveBeenCalledWith(
        'Emulation.setUserAgentOverride',
        expect.anything()
      )
    })

    it('clears device metrics and disables touch for override=null', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4343)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-clear',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })

      const ok = await browserManager.setViewportOverride('tab-clear', null)
      expect(ok).toBe(true)

      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride', {})
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', {
        enabled: false,
        maxTouchPoints: 0
      })
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
        userAgent: ''
      })
    })

    it('attaches the debugger if not already attached and does not detach after', async () => {
      const { guest, debuggerSendCommand, debuggerAttach } = makeGuest(4444)
      ;(guest.debugger as { isAttached: ReturnType<typeof vi.fn> }).isAttached = vi.fn(() => false)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-attach',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })

      await browserManager.setViewportOverride('tab-attach', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })

      expect(debuggerAttach).toHaveBeenCalledWith('1.3')
      expect(debuggerSendCommand).toHaveBeenCalled()
      // Why: detaching would clear Page.addScriptToEvaluateOnNewDocument
      // (anti-detection). Guard regression.
      expect((guest.debugger as { detach?: unknown }).detach ?? undefined).toBeUndefined()
    })

    it('returns false when debugger.attach throws (e.g. DevTools already open)', async () => {
      const { guest, debuggerSendCommand, debuggerAttach } = makeGuest(4545)
      ;(guest.debugger as { isAttached: ReturnType<typeof vi.fn> }).isAttached = vi.fn(() => false)
      // Why: Electron throws from debugger.attach if another client (e.g. the
      // user's open DevTools window) is already attached. setViewportOverride
      // must surface this as a clean `false` rather than an unhandled rejection.
      debuggerAttach.mockImplementation(() => {
        throw new Error('Another debugger is already attached')
      })
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-attach-throws',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })

      const ok = await browserManager.setViewportOverride('tab-attach-throws', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })

      expect(ok).toBe(false)
      expect(debuggerAttach).toHaveBeenCalledWith('1.3')
      expect(debuggerSendCommand).not.toHaveBeenCalled()
    })

    it('installs annotation viewport bridge in an isolated world', async () => {
      const { guest } = makeGuest(4646)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-annotations',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })

      const ok = await browserManager.setAnnotationViewportBridge('tab-annotations', {
        emitViewport: false,
        enabled: true,
        markers: [],
        token: 'annotationviewporttoken'
      })

      expect(ok).toBe(true)
      expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
        expect.any(Number),
        [
          expect.objectContaining({
            code: expect.stringContaining('__orcaBrowserAnnotationViewportBridge')
          })
        ],
        false
      )
    })
  })
})
