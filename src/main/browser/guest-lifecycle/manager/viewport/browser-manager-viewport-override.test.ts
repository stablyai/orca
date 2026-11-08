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
  processUserAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
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
    mode: browserMocks.processUserAgentMode,
    userAgent: browserMocks.processUserAgent,
    electronUserAgent:
      browserMocks.processUserAgentMode === 'native'
        ? browserMocks.processUserAgent
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/134.0.0.0 Electron/30.0.0 Safari/537.36'
  })
}))

vi.mock('../../../identity/browser-tab-identity', async (importOriginal) =>
  (
    await import('./browser-manager-desktop-ua-metadata-test-fixture')
  ).withPinnedDesktopUserAgentMetadata(await importOriginal<object>())
)

import { browserManager } from '../browser-manager'
import { googleAuthUserAgent } from '../../../identity/browser-google-auth-ua'
import {
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from '../browser-manager-test-harness'
import { pinnedDesktopUserAgentMetadata as desktopMetadata } from './browser-manager-desktop-ua-metadata-test-fixture'
import {
  createViewportGuestFactory,
  flushViewportOps,
  GUEST_CLEAN_UA
} from './browser-manager-viewport-test-fixtures'

const { guestOnMock, webContentsFromIdMock } = browserMocks
const makeGuest = createViewportGuestFactory(browserMocks)
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
    browserMocks.processUserAgentMode = 'clean'
    browserMocks.processUserAgent = GUEST_CLEAN_UA
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('setViewportOverride', () => {
    // CDP overrides outrank the WebContents UA and must match the auth-host request identity.

    function lastUserAgentOverride(
      debuggerSendCommand: ReturnType<typeof vi.fn>
    ): Record<string, unknown> | undefined {
      const calls = debuggerSendCommand.mock.calls.filter(
        (call) => call[0] === 'Emulation.setUserAgentOverride'
      )
      return calls.at(-1)?.[1] as Record<string, unknown> | undefined
    }

    // Mobile presets install a Chrome-shaped UA that must not outlive navigation onto an auth host.
    it('does not leave the Chrome preset UA standing when a mobile preset lands mid-navigation onto an auth host', async () => {
      const { guest, debuggerSendCommand, presentedUserAgent } = makeGuest(
        4251,
        'https://example.com/'
      )
      // Hold metrics so navigation occurs while the preset is awaiting CDP.
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

      const presetDone = browserManager.setViewportOverride(
        'tab-race-onto-auth',
        MOBILE_VIEWPORT_OVERRIDE
      )
      await flushViewportOps()

      didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
      releaseMetrics()
      await presetDone
      await flushViewportOps()

      expect(presentedUserAgent()).toBe(googleAuthUserAgent())
      expect(debuggerSendCommand).not.toHaveBeenCalledWith(
        'Emulation.setUserAgentOverride',
        expect.objectContaining({ userAgent: expect.stringContaining('iPhone') })
      )
    })

    it('does not leave the auth UA standing when a preset lands mid-navigation off an auth host', async () => {
      const { guest, debuggerSendCommand, presentedUserAgent } = makeGuest(
        4252,
        'https://accounts.google.com/'
      )
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

      await browserManager.setViewportOverride('tab-race-off-auth', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await flushViewportOps()
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({
        userAgent: googleAuthUserAgent(),
        userAgentMetadata: desktopMetadata
      })

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

      expect(presentedUserAgent()).toBe(GUEST_CLEAN_UA)
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({ userAgent: '' })
    })

    it('falls back to the committed URL once a navigation commits or fails', async () => {
      const { guest, debuggerSendCommand, commitNavigationTo, presentedUserAgent } = makeGuest(
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

      // An aborted target must not determine the identity of later preset writes.
      didStartNavigation(null, 'https://accounts.google.com/', false, true)
      didFailLoad(null, -3, 'Aborted', 'https://accounts.google.com/', true)
      await flushViewportOps()

      expect(guest.setUserAgent).toHaveBeenCalledOnce()
      expect(presentedUserAgent()).toBe(GUEST_CLEAN_UA)

      debuggerSendCommand.mockClear()
      await browserManager.setViewportOverride('tab-pending-cleared', MOBILE_VIEWPORT_OVERRIDE)
      await flushViewportOps()
      expect(lastUserAgentOverride(debuggerSendCommand)?.userAgent).toContain('iPhone')

      didStartNavigation(null, 'https://accounts.google.com/signin', false, true)
      commitNavigationTo('https://accounts.google.com/signin')
      didNavigate(null, 'https://accounts.google.com/signin')
      await flushViewportOps()

      await browserManager.setViewportOverride('tab-pending-cleared', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await flushViewportOps()
      expect(presentedUserAgent()).toBe(googleAuthUserAgent())
    })

    it('does not let a superseded navigation failure revert a newer target', async () => {
      const { guest, debuggerSendCommand, presentedUserAgent } = makeGuest(
        4255,
        'https://example.com/'
      )
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
      expect(presentedUserAgent()).toBe(googleAuthUserAgent())

      debuggerSendCommand.mockClear()
      didFailLoad(null, -3, 'Aborted', 'https://accounts.google.com/same', true)
      await flushViewportOps()

      expect(guest.setUserAgent).toHaveBeenCalledOnce()
      expect(debuggerSendCommand).not.toHaveBeenCalledWith(
        'Emulation.setUserAgentOverride',
        expect.anything()
      )
      expect(presentedUserAgent()).toBe(googleAuthUserAgent())
    })

    it('does not reinstall a preset while its final UA clear is in flight', async () => {
      const { guest, debuggerSendCommand, presentedUserAgent } = makeGuest(
        4258,
        'https://example.com/'
      )
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

      await browserManager.setViewportOverride('tab-final-clear-race', MOBILE_VIEWPORT_OVERRIDE)
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
      expect(debuggerSendCommand).not.toHaveBeenCalledWith(
        'Emulation.setUserAgentOverride',
        expect.objectContaining({ userAgent: expect.stringContaining('iPhone') })
      )

      releaseClearUa()
      await clearDone
      await flushViewportOps()
      expect(presentedUserAgent()).toBe(googleAuthUserAgent())
    })

    // Keep failed clears tracked so later navigation can correct the standing override.
    it('keeps tracking the standing override when the CDP clear fails', async () => {
      const { guest, debuggerSendCommand, presentedUserAgent } = makeGuest(
        4254,
        'https://example.com/'
      )
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

      await browserManager.setViewportOverride('tab-failed-clear', MOBILE_VIEWPORT_OVERRIDE)
      await flushViewportOps()

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

      debuggerSendCommand.mockImplementation(() => Promise.resolve(undefined))
      debuggerSendCommand.mockClear()
      didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
        userAgent: ''
      })
      expect(presentedUserAgent()).toBe(googleAuthUserAgent())
    })
  })
})
