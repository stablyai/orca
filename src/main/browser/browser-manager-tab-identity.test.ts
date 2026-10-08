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
vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: mocks.openPopupWithOriginBarMock
}))
vi.mock('./browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({
    mode: mocks.processUserAgentMode,
    userAgent: mocks.processUserAgent
  })
}))

import { browserManager } from './browser-manager'
import { googleAuthUserAgent } from './browser-google-auth-ua'
import { resetBrowserManagerMocks, resetBrowserManagerState } from './browser-manager-test-harness'
import {
  createViewportGuestFactory,
  flushViewportOps,
  GUEST_CLEAN_UA,
  GUEST_ELECTRON_UA,
  type ViewportGuestHandle
} from './browser-manager-viewport-test-fixtures'

const makeGuest = createViewportGuestFactory(mocks)
const guests = new Map<number, Record<string, unknown>>()
const PRESETS = {
  none: null,
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }
} as const
type Preset = keyof typeof PRESETS
const MODES = [
  ['clean', GUEST_CLEAN_UA],
  ['native', GUEST_ELECTRON_UA]
] as const
const ORDINARY_URL = 'https://example.com/'
const AUTH_URL = 'https://accounts.google.com/v3/signin/identifier'
const APP_TOKENS = /Electron\/|orca\//i
let nextGuestId = 7000

type Observed = {
  presented: string
  standingOverride: Record<string, unknown> | null
  requestIdentity: ReturnType<typeof browserManager.resolveBrowserGuestRequestUserAgent>
}

/** Opens a tab on `url` the way a real load does: did-start-navigation runs before any preset. */
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

function redirectTo(url: string): void {
  const willRedirect = mocks.guestOnMock.mock.calls.findLast(
    ([event]) => event === 'will-redirect'
  )?.[1]
  willRedirect({ preventDefault: vi.fn() }, url, false, true)
}

// A redirect target that fails: the one failed-load path whose restore could otherwise write the UA.
function failLoad(url: string): void {
  redirectTo(url)
  const didFailLoad = mocks.guestOnMock.mock.calls.findLast(
    ([event]) => event === 'did-fail-load'
  )?.[1]
  didFailLoad(null, -102, 'ERR_CONNECTION_REFUSED', url, true)
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

async function presentWith(url: string, preset: Preset): Promise<Observed> {
  const opened = openTab(url)
  const override = PRESETS[preset]
  if (override) {
    await browserManager.setViewportOverride(opened.tab, override)
  }
  return observe(opened, url)
}

// Why: Chromium drops navigator.userAgentData and every sec-ch-ua header for a UA override that
// carries no userAgentMetadata, so only Firefox (which sends no hints) may stand without it.
function expectClientHintsKept(observed: Observed): void {
  const override = observed.standingOverride
  if (override && override.userAgent !== googleAuthUserAgent()) {
    expect(override.userAgentMetadata).toBeDefined()
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

  describe.each(MODES)('in %s mode', (mode, processUserAgent) => {
    beforeEach(() => {
      mocks.processUserAgentMode = mode
      mocks.processUserAgent = processUserAgent
    })

    it.each([ORDINARY_URL, AUTH_URL])(
      'presents the same identity with a desktop preset as with none on %s',
      async (url) => {
        const none = await presentWith(url, 'none')
        const desktop = await presentWith(url, 'desktop')
        expect(desktop).toEqual(none)
        expectClientHintsKept(desktop)
        const expected =
          mode === 'clean' && url === AUTH_URL ? googleAuthUserAgent() : processUserAgent
        expect(desktop.presented).toBe(expected)
        expect(desktop.requestIdentity.userAgent).toBe(expected)
        expect(desktop.requestIdentity.kind).toBe(
          expected === processUserAgent ? 'process' : 'google-auth'
        )
      }
    )

    it('presents the mobile identity with matching client hints on an ordinary host', async () => {
      const observed = await presentWith(ORDINARY_URL, 'mobile')
      expect(observed.presented).toContain('iPhone')
      expect(observed.standingOverride).toMatchObject({
        userAgentMetadata: expect.objectContaining({ mobile: true, platform: 'iOS' })
      })
      expect(observed.requestIdentity.kind).toBe('mobile')
      expect(observed.requestIdentity.userAgent).toBe(observed.presented)
    })

    it('keeps the Google sign-in identity ahead of a mobile preset only in clean mode', async () => {
      const observed = await presentWith(AUTH_URL, 'mobile')
      expectClientHintsKept(observed)
      if (mode === 'clean') {
        expect(observed.presented).toBe(googleAuthUserAgent())
        expect(observed.requestIdentity.kind).toBe('google-auth')
      } else {
        expect(observed.presented).toContain('iPhone')
        expect(observed.requestIdentity.kind).toBe('mobile')
      }
    })

    it.each(['desktop', 'none'] as const)(
      'restores the process identity when switching from mobile to %s',
      async (next) => {
        const opened = openTab(ORDINARY_URL)
        await browserManager.setViewportOverride(opened.tab, PRESETS.mobile)
        expect(opened.handle.presentedUserAgent()).toContain('iPhone')

        await browserManager.setViewportOverride(opened.tab, PRESETS[next])
        const observed = await observe(opened, ORDINARY_URL)
        expect(observed.presented).toBe(processUserAgent)
        expect(observed.standingOverride).toBeNull()
        expect(observed.requestIdentity).toEqual({ kind: 'process', userAgent: processUserAgent })
      }
    )
  })

  it('never puts the Electron or app tokens on a clean-mode tab under any preset', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    for (const url of [ORDINARY_URL, AUTH_URL]) {
      for (const preset of ['none', 'desktop', 'mobile'] as const) {
        const observed = await presentWith(url, preset)
        expect(observed.presented).not.toMatch(APP_TOKENS)
        expect(observed.requestIdentity.userAgent).not.toMatch(APP_TOKENS)
      }
    }
  })

  // Why: Chromium rejects touch emulation with maxTouchPoints 0, so every step after it used to be
  // skipped and the mobile UA outlived its preset. Identity is no longer a step after touch.
  it('restores the process identity and reports the failure when touch emulation is rejected', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const opened = openTab(ORDINARY_URL)
    await browserManager.setViewportOverride(opened.tab, PRESETS.mobile)
    // Rejects whatever the payload, so the test outlives a fix to the payload itself.
    opened.handle.debuggerSendCommand.mockImplementation((method: string) =>
      method === 'Emulation.setTouchEmulationEnabled'
        ? Promise.reject(new Error('Touch points must be between 1 and 16'))
        : Promise.resolve(undefined)
    )

    await expect(browserManager.setViewportOverride(opened.tab, PRESETS.desktop)).resolves.toBe(
      false
    )
    const observed = await observe(opened, ORDINARY_URL)
    expect(observed.presented).toBe(GUEST_CLEAN_UA)
    expect(observed.standingOverride).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      '[browser-manager] setViewportOverride: touch emulation failed',
      expect.objectContaining({ error: 'Touch points must be between 1 and 16' })
    )
  })

  // Why: identity follows the viewport Chromium holds, so a phone identity never stands on a desktop
  // viewport. The renderer re-sends the preset on the next page load, which heals the tab.
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

  // Why: a detach clears the device metrics along with the UA override, so the next page must not
  // reinstall a phone identity on the desktop viewport that remains.
  it('drops the mobile identity once a debugger detach clears the device metrics', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    const opened = openTab(ORDINARY_URL)
    await browserManager.setViewportOverride(opened.tab, PRESETS.mobile)
    expect(opened.handle.presentedUserAgent()).toContain('iPhone')

    debuggerDetachHandler(opened.handle)()
    opened.handle.debuggerSendCommand.mockClear()
    navigate('https://example.org/')
    const observed = await observe(opened, 'https://example.org/')
    expect(opened.handle.debuggerSendCommand).not.toHaveBeenCalledWith(
      'Emulation.setUserAgentOverride',
      expect.anything()
    )
    expect(observed.requestIdentity).toEqual({ kind: 'process', userAgent: GUEST_CLEAN_UA })
  })

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
    // Another CDP client (the agent bridge) re-attaches before the preset is sent again.
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

  it('heals a mid-redirect process override on the next navigation', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    const opened = openTab(AUTH_URL)
    await browserManager.setViewportOverride(opened.tab, PRESETS.desktop)
    const willRedirect = mocks.guestOnMock.mock.calls.findLast(
      ([event]) => event === 'will-redirect'
    )?.[1]
    willRedirect({ preventDefault: vi.fn() }, ORDINARY_URL, false, true)
    // The WebContents UA still says Firefox, so clearing here would expose it on an ordinary host.
    expect((await observe(opened, ORDINARY_URL)).presented).toBe(GUEST_CLEAN_UA)

    navigate('https://example.org/')
    const healed = await observe(opened, 'https://example.org/')
    expect(healed.presented).toBe(GUEST_CLEAN_UA)
    expect(healed.standingOverride).toBeNull()
  })

  // Why a table over every entry point: Chromium cancels a redirect, and reloads a loading document,
  // when the WebContents UA changes anywhere but a cross-document navigation start.
  it.each([
    ['a redirect', () => redirectTo(ORDINARY_URL)],
    ['a failed load', () => failLoad(ORDINARY_URL)],
    ['a desktop preset', (tab: string) => browserManager.setViewportOverride(tab, PRESETS.desktop)],
    ['a mobile preset', (tab: string) => browserManager.setViewportOverride(tab, PRESETS.mobile)],
    ['clearing a preset', (tab: string) => browserManager.setViewportOverride(tab, null)],
    ['a same-document navigation', () => navigate(`${AUTH_URL}#step`, { inPlace: true })]
  ])(
    'writes the WebContents UA only at a cross-document navigation start, not on %s',
    async (_label, act) => {
      mocks.processUserAgentMode = 'clean'
      mocks.processUserAgent = GUEST_CLEAN_UA
      const opened = openTab(AUTH_URL)
      expect(opened.handle.guest.setUserAgent).toHaveBeenCalledOnce()

      await act(opened.tab)
      await flushViewportOps()
      expect(opened.handle.guest.setUserAgent).toHaveBeenCalledOnce()

      navigate('https://example.org/')
      // Synchronous: the write must land inside did-start-navigation, before any await.
      expect(opened.handle.guest.setUserAgent).toHaveBeenCalledTimes(2)
      expect(opened.handle.webContentsUserAgent()).toBe(GUEST_CLEAN_UA)
    }
  )

  // Why: setUserAgent() while a document loads makes Chromium reload it, and an OAuth callback that
  // strips its code with replaceState would be requested twice — the one-time code replayed.
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

  // Why: a failed navigation commits an error page that is still loading at did-fail-load, and
  // setUserAgent() then makes Chromium reload it — the failed request replayed.
  it('leaves the WebContents UA alone when a redirected navigation fails', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    const opened = openTab(ORDINARY_URL)
    navigate(`${ORDINARY_URL}start`)
    const willRedirect = mocks.guestOnMock.mock.calls.findLast(
      ([event]) => event === 'will-redirect'
    )?.[1]
    willRedirect({ preventDefault: vi.fn() }, AUTH_URL, false, true)
    await flushViewportOps()

    opened.handle.commitNavigationTo(AUTH_URL)
    const didFailLoad = mocks.guestOnMock.mock.calls.findLast(
      ([event]) => event === 'did-fail-load'
    )?.[1]
    didFailLoad(null, -102, 'ERR_CONNECTION_REFUSED', AUTH_URL, true)
    expect(opened.handle.webContentsUserAgent()).toBe(GUEST_CLEAN_UA)
    const observed = await observe(opened, AUTH_URL)
    expect(observed.presented).toBe(googleAuthUserAgent())
    expect(observed.requestIdentity.kind).toBe('google-auth')
  })

  // Why: a debugger that cannot attach (DevTools open on the guest) installs no mobile identity, so
  // requests claiming one would disagree with the document's own navigator.userAgent.
  it('keeps requests on the presented identity when a mobile preset cannot attach', async () => {
    mocks.processUserAgentMode = 'clean'
    mocks.processUserAgent = GUEST_CLEAN_UA
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const opened = openTab(ORDINARY_URL)
    opened.handle.debuggerIsAttached.mockReturnValue(false)
    opened.handle.debuggerAttach.mockImplementation(() => {
      throw new Error('Another debugger is already attached')
    })

    await expect(browserManager.setViewportOverride(opened.tab, PRESETS.mobile)).resolves.toBe(
      false
    )
    navigate('https://example.org/')
    const observed = await observe(opened, 'https://example.org/')
    expect(observed.presented).toBe(GUEST_CLEAN_UA)
    expect(observed.requestIdentity).toEqual({ kind: 'process', userAgent: GUEST_CLEAN_UA })
  })
})
