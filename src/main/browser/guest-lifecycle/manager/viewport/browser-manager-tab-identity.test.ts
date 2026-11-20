import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
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
  processUserAgent: ''
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.appGetPathMock },
  BrowserWindow: { fromWebContents: mocks.browserWindowFromWebContentsMock },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: mocks.shellOpenExternalMock },
  Menu: { buildFromTemplate: mocks.menuBuildFromTemplateMock },
  screen: { getCursorScreenPoint: mocks.screenGetCursorScreenPointMock },
  webContents: { fromId: mocks.webContentsFromIdMock }
}))
vi.mock('../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: mocks.openPopupWithOriginBarMock
}))
vi.mock('../../../identity/browser-process-user-agent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBrowserProcessUserAgentIdentity: () => ({
    mode: mocks.processUserAgentMode,
    userAgent: mocks.processUserAgent,
    electronUserAgent:
      mocks.processUserAgentMode === 'native'
        ? mocks.processUserAgent
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/134.0.0.0 Electron/30.0.0 Safari/537.36'
  })
}))

import { browserManager } from '../browser-manager'
import { hasBrowserSessionUserAgentDemand } from '../../../identity/requests/browser-session-ua-demand'
import { BROWSER_GUEST_SUBFRAME_UNLOADED_CHANNEL } from '../../../../../shared/browser/identity/browser-subframe-unload'
import { googleAuthUserAgent } from '../../../identity/browser-site-user-agent'
import { resetBrowserManagerMocks, resetBrowserManagerState } from '../browser-manager-test-harness'
import {
  createViewportGuestFactory,
  flushViewportOps,
  GUEST_CLEAN_UA,
  type ViewportGuestHandle
} from './browser-manager-viewport-test-fixtures'

const makeGuest = createViewportGuestFactory(mocks)
const guests = new Map<number, Record<string, unknown>>()
const PRESETS = {
  none: null,
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }
} as const
const ORDINARY_URL = 'https://example.com/'
const AUTH_URL = 'https://accounts.google.com/v3/signin/identifier'
let nextGuestId = 7000

type Observed = {
  presented: string
  standingOverride: Record<string, unknown> | null
  requestIdentity: ReturnType<typeof browserManager.resolveBrowserGuestRequestUserAgent>
}

function openTab(url: string): { tab: string; id: number; handle: ViewportGuestHandle } {
  const id = nextGuestId++
  const tab = `tab-${id}`
  const handle = makeGuest(id, url)
  guests.set(id, handle.guest)
  expect(browserManager.registerOffscreenGuest({ browserPageId: tab, webContentsId: id })).toBe(
    true
  )
  navigate(url)
  return { tab, id, handle }
}

function navigate(url: string, { inPlace = false } = {}): void {
  const didStartNavigation = mocks.guestOnMock.mock.calls.filter(
    ([event]) => event === 'did-start-navigation'
  )
  expect(didStartNavigation.length).toBeGreaterThan(0)
  for (const [, listener] of didStartNavigation) {
    listener({ url, isSameDocument: inPlace, isMainFrame: true }, url, inPlace, true)
  }
}

function failDeviceMetrics(handle: ViewportGuestHandle): void {
  handle.debuggerSendCommand.mockImplementation((method: string) =>
    method === 'Emulation.setDeviceMetricsOverride' ||
    method === 'Emulation.clearDeviceMetricsOverride'
      ? Promise.reject(new Error('Inspected target navigated or closed'))
      : Promise.resolve(undefined)
  )
}

function debuggerDetachHandler(handle: ViewportGuestHandle): () => void {
  const debuggerApi = handle.guest.debugger
  const on =
    debuggerApi && typeof debuggerApi === 'object' && 'on' in debuggerApi ? debuggerApi.on : null
  if (!vi.isMockFunction(on)) {
    throw new Error('Expected a mocked debugger.on')
  }
  const handler: unknown = on.mock.calls.findLast(([event]) => event === 'detach')?.[1]
  if (typeof handler !== 'function') {
    throw new Error('Expected a debugger detach handler')
  }
  return () => handler()
}

async function observe(
  { id, handle }: { id: number; handle: ViewportGuestHandle },
  url: string
): Promise<Observed> {
  await flushViewportOps()
  return {
    presented: handle.presentedUserAgent(),
    standingOverride: handle.standingUserAgentOverride(),
    requestIdentity: browserManager.resolveBrowserGuestRequestUserAgent({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads no Session member.
      session: handle.guest.session as Electron.Session,
      url,
      webContentsId: id
    })
  }
}

describe('tab identity ownership', () => {
  beforeEach(() => {
    expect(process.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    resetBrowserManagerMocks(mocks)
    resetBrowserManagerState()
    guests.clear()
    mocks.webContentsFromIdMock.mockImplementation((id) => guests.get(id))
  })
  afterEach(() => {
    browserManager.unregisterAll()
    vi.restoreAllMocks()
  })

  it('keeps the process identity when a mobile preset cannot apply its device metrics', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const opened = openTab(ORDINARY_URL)
    failDeviceMetrics(opened.handle)

    await expect(browserManager.setViewportOverride(opened.tab, PRESETS.mobile)).resolves.toBe(
      false
    )
    const failed = await observe(opened, ORDINARY_URL)
    expect(failed.presented).toBe(GUEST_CLEAN_UA)
    expect(failed.standingOverride).toBeNull()
    expect(failed.requestIdentity).toEqual({ kind: 'process', userAgent: GUEST_CLEAN_UA })
    navigate('https://example.org/')
    expect((await observe(opened, 'https://example.org/')).presented).toBe(GUEST_CLEAN_UA)

    opened.handle.debuggerSendCommand.mockResolvedValue(undefined)
    await expect(browserManager.setViewportOverride(opened.tab, PRESETS.mobile)).resolves.toBe(true)
    expect((await observe(opened, 'https://example.org/')).requestIdentity.kind).toBe('mobile')
  })

  it.each(['desktop', 'none'] as const)(
    'keeps the mobile identity while the phone viewport stands when switching to %s fails',
    async (next) => {
      mocks.processUserAgentMode = 'clean'
      mocks.processUserAgent = GUEST_CLEAN_UA
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const opened = openTab(ORDINARY_URL)
      await browserManager.setViewportOverride(opened.tab, PRESETS.mobile)
      failDeviceMetrics(opened.handle)

      await expect(browserManager.setViewportOverride(opened.tab, PRESETS[next])).resolves.toBe(
        false
      )
      const failed = await observe(opened, ORDINARY_URL)
      expect(failed.presented).toContain('iPhone')
      expect(failed.requestIdentity.kind).toBe('mobile')
      navigate('https://example.org/')
      const reloaded = await observe(opened, 'https://example.org/')
      expect(reloaded.presented).toContain('iPhone')
      expect(reloaded.requestIdentity.kind).toBe('mobile')
    }
  )

  it('does not let a mid-apply debugger detach leave a mobile identity to reinstall', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const opened = openTab(ORDINARY_URL)
    const detach = debuggerDetachHandler(opened.handle)
    opened.handle.debuggerSendCommand.mockImplementation((method: string) => {
      if (method !== 'Emulation.setTouchEmulationEnabled') {
        return Promise.resolve(undefined)
      }
      opened.handle.debuggerIsAttached.mockReturnValue(false)
      detach()
      return Promise.reject(new Error('Debugger is not attached'))
    })

    await expect(browserManager.setViewportOverride(opened.tab, PRESETS.mobile)).resolves.toBe(
      false
    )
    // Another CDP client can reattach before the viewport preset returns.
    opened.handle.debuggerIsAttached.mockReturnValue(true)
    opened.handle.debuggerSendCommand.mockClear()
    navigate('https://example.org/')
    const observed = await observe(opened, 'https://example.org/')
    expect(opened.handle.debuggerSendCommand).not.toHaveBeenCalledWith(
      'Emulation.setUserAgentOverride',
      expect.anything()
    )
    expect(observed.requestIdentity).toEqual({ kind: 'process', userAgent: GUEST_CLEAN_UA })
  })

  // Changing UA during same-document navigation can reload and replay an OAuth one-time code.
  it('leaves the WebContents UA alone on a same-document navigation', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    const opened = openTab(AUTH_URL)
    const willRedirect = mocks.guestOnMock.mock.calls.findLast(
      ([event]) => event === 'will-redirect'
    )?.[1]
    willRedirect({ preventDefault: vi.fn() }, `${ORDINARY_URL}callback?code=1`, false, true)
    await flushViewportOps()

    navigate(`${ORDINARY_URL}callback`, { inPlace: true })
    expect(opened.handle.webContentsUserAgent()).toBe(googleAuthUserAgent())
    expect((await observe(opened, ORDINARY_URL)).presented).toBe(GUEST_CLEAN_UA)

    navigate('https://example.org/')
    expect(opened.handle.webContentsUserAgent()).toBe(GUEST_CLEAN_UA)
  })

  it.each([false, true])(
    'preserves detached auth identity correction (failure=%s)',
    async (fail) => {
      mocks.processUserAgentMode = 'clean'
      mocks.processUserAgent = GUEST_CLEAN_UA
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const opened = openTab(AUTH_URL)
      opened.handle.debuggerIsAttached.mockReturnValue(false)
      await expect(browserManager.setViewportOverride(opened.tab, null)).resolves.toBe(true)
      expect(opened.handle.debuggerAttach).not.toHaveBeenCalled()
      navigate(`${ORDINARY_URL}callback`, { inPlace: true })
      if (fail) {
        opened.handle.debuggerSendCommand.mockRejectedValue(new Error('Identity write failed'))
      }
      await expect(browserManager.setViewportOverride(opened.tab, null)).resolves.toBe(!fail)
      expect(opened.handle.debuggerAttach).toHaveBeenCalledWith('1.3')
      expect(opened.handle.webContentsUserAgent()).toBe(googleAuthUserAgent())
      const observed = await observe(opened, ORDINARY_URL)
      expect(observed.presented).toBe(fail ? googleAuthUserAgent() : GUEST_CLEAN_UA)
    }
  )

  it('serializes a detached mobile apply before clearing to the default identity', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    const opened = openTab(ORDINARY_URL)
    opened.handle.debuggerIsAttached.mockReturnValue(false)
    let finish = (): void => {}
    opened.handle.debuggerSendCommand.mockImplementation((method: string) =>
      method === 'Emulation.setDeviceMetricsOverride'
        ? new Promise<void>((resolve) => {
            finish = resolve
          })
        : Promise.resolve(undefined)
    )
    const mobile = browserManager.setViewportOverride(opened.tab, PRESETS.mobile)
    const reset = browserManager.setViewportOverride(opened.tab, null)
    await flushViewportOps()
    finish()
    await expect(mobile).resolves.toBe(true)
    await expect(reset).resolves.toBe(true)
    expect(opened.handle.debuggerSendCommand).toHaveBeenCalledWith(
      'Emulation.clearDeviceMetricsOverride',
      {}
    )
    const observed = await observe(opened, ORDINARY_URL)
    expect(observed.presented).toBe(GUEST_CLEAN_UA)
    expect(observed.standingOverride).toBeNull()
    expect(observed.requestIdentity).toEqual({ kind: 'process', userAgent: GUEST_CLEAN_UA })
  })
  it('turns the header policy off once a site iframe fails or is removed', async () => {
    vi.useFakeTimers()
    mocks.processUserAgentMode = 'native'
    mocks.processUserAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/134.0.0.0 Electron/30.0.0 Safari/537.36'
    const { handle } = openTab(ORDINARY_URL)
    const teamsUrl = 'https://teams.microsoft.com/v2/'
    const teamsFrame = { url: teamsUrl, origin: 'https://teams.microsoft.com' }
    const mainFrame: { url: string; origin: string; framesInSubtree: object[] } = {
      url: ORDINARY_URL,
      origin: 'https://example.com',
      framesInSubtree: []
    }
    mainFrame.framesInSubtree = [mainFrame, teamsFrame]
    let loading = false
    Object.assign(handle.guest, { mainFrame, isLoading: () => loading })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: demand keys on session identity only.
    const session = handle.guest.session as Electron.Session
    const fire = (event: string, ...args: unknown[]): void => {
      for (const [name, listener] of mocks.guestOnMock.mock.calls) {
        if (name === event) {
          listener(...args)
        }
      }
    }
    const subframeUnloaded = (): void => {
      fire('ipc-message', { sender: handle.guest }, BROWSER_GUEST_SUBFRAME_UNLOADED_CHANNEL)
      vi.advanceTimersByTime(1_000)
    }
    try {
      fire('did-start-navigation', {}, teamsUrl, false, false)
      expect(hasBrowserSessionUserAgentDemand(session)).toBe(true)
      fire('did-stop-loading')
      expect(hasBrowserSessionUserAgentDemand(session)).toBe(true)
      // Blocked by the site's frame-ancestors: an error page that keeps the Teams URL.
      teamsFrame.origin = 'null'
      fire('did-stop-loading')
      expect(hasBrowserSessionUserAgentDemand(session)).toBe(false)
      // A new Teams iframe still loading (no URL committed yet) when another frame unloads.
      loading = true
      teamsFrame.url = ''
      teamsFrame.origin = 'https://example.com'
      fire('did-start-navigation', {}, teamsUrl, false, false)
      subframeUnloaded()
      expect(hasBrowserSessionUserAgentDemand(session)).toBe(true)
      // It commits, then is removed after the page finished loading.
      loading = false
      teamsFrame.url = teamsUrl
      teamsFrame.origin = 'https://teams.microsoft.com'
      fire('did-stop-loading')
      expect(hasBrowserSessionUserAgentDemand(session)).toBe(true)
      mainFrame.framesInSubtree = [mainFrame]
      subframeUnloaded()
      expect(hasBrowserSessionUserAgentDemand(session)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
