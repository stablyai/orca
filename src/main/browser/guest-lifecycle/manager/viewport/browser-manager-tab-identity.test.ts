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
vi.mock('../../../identity/browser-process-user-agent', () => ({
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
import { googleAuthUserAgent } from '../../../identity/browser-google-auth-ua'
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
  const didStartNavigation = mocks.guestOnMock.mock.calls.findLast(
    ([event]) => event === 'did-start-navigation'
  )?.[1]
  expect(didStartNavigation).toBeTypeOf('function')
  didStartNavigation(null, url, inPlace, true)
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

  // Changing UA while the error page loads can replay the failed request.

  // A failed attachment must not advertise mobile identity on requests alone.
})
