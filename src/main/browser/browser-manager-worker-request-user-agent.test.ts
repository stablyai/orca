import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  app: { getPath: browserMocks.appGetPathMock },
  BrowserWindow: { fromWebContents: browserMocks.browserWindowFromWebContentsMock },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: browserMocks.shellOpenExternalMock },
  Menu: { buildFromTemplate: browserMocks.menuBuildFromTemplateMock },
  screen: { getCursorScreenPoint: browserMocks.screenGetCursorScreenPointMock },
  webContents: { fromId: browserMocks.webContentsFromIdMock }
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
import {
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'
import {
  createViewportGuestFactory,
  GUEST_CLEAN_UA
} from './browser-manager-viewport-test-fixtures'

const { webContentsFromIdMock } = browserMocks
const makeGuest = createViewportGuestFactory(browserMocks)
const MOBILE_VIEWPORT_OVERRIDE = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }
const MOBILE_UA_PATTERN = /CriOS\//

function registerGuest(browserPageId: string, webContentsId: number): Electron.Session {
  const { guest } = makeGuest(webContentsId)
  webContentsFromIdMock.mockReturnValue(guest)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared viewport fixture builds an untyped guest stub; the manager only reads members that stub defines.
  browserManager.attachGuestPolicies(guest as never)
  browserManager.registerGuest({ browserPageId, webContentsId, rendererWebContentsId })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveBrowserGuestRequestUserAgent reads no Session member, so the stub only has to be the object the guest carries.
  return guest.session as Electron.Session
}

function resolve(session: Electron.Session, webContentsId?: number): string {
  return browserManager.resolveBrowserGuestRequestUserAgent({
    session,
    url: 'https://example.com/asset.js',
    webContentsId
  }).userAgent
}

// Shared/service worker requests lack a guest ID and must retain their process identity.
describe('worker request identity under viewport emulation', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
    browserMocks.processUserAgentMode = 'clean'
    browserMocks.processUserAgent = GUEST_CLEAN_UA
  })

  it('keeps a worker request desktop-clean while a tab in the same session is emulated mobile', async () => {
    const session = registerGuest('tab-mobile', 4242)
    expect(await browserManager.setViewportOverride('tab-mobile', MOBILE_VIEWPORT_OVERRIDE)).toBe(
      true
    )

    expect(resolve(session)).toBe(GUEST_CLEAN_UA)
  })

  it('still resolves the mobile identity for the emulated tab itself', async () => {
    const session = registerGuest('tab-mobile', 4242)
    expect(await browserManager.setViewportOverride('tab-mobile', MOBILE_VIEWPORT_OVERRIDE)).toBe(
      true
    )

    expect(resolve(session, 4242)).toMatch(MOBILE_UA_PATTERN)
  })

  it('leaves a desktop tab desktop-clean while a peer tab in its session is emulated mobile', async () => {
    const session = registerGuest('tab-mobile', 4242)
    registerGuest('tab-desktop', 4243)
    expect(await browserManager.setViewportOverride('tab-mobile', MOBILE_VIEWPORT_OVERRIDE)).toBe(
      true
    )

    expect(resolve(session, 4243)).toBe(GUEST_CLEAN_UA)
  })

  it('keeps worker requests desktop-clean when no tab is emulated at all', () => {
    const session = registerGuest('tab-plain', 4244)

    expect(resolve(session)).toBe(GUEST_CLEAN_UA)
  })

  // Unmapped guests must not inherit another tab's mobile override.
  it('keeps an unmapped webContents desktop-clean beside an emulated tab', async () => {
    const session = registerGuest('tab-mobile', 4242)
    expect(await browserManager.setViewportOverride('tab-mobile', MOBILE_VIEWPORT_OVERRIDE)).toBe(
      true
    )

    expect(resolve(session, 9999)).toBe(GUEST_CLEAN_UA)
  })
})
