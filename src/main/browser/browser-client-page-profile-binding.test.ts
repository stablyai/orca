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

import { browserManager } from './browser-manager'
import { createBrowserClientPageGuestBinding } from './browser-client-page-guest-binding'
import { resetBrowserManagerMocks, resetBrowserManagerState } from './browser-manager-test-harness'

const registration = (webContentsId: number, pageHostGeneration: number) => ({
  partition: 'persist:route',
  browserPageId: 'page-a',
  webContentsId,
  pageHostGeneration,
  rendererWebContentsId: 5001
})

beforeEach(() => {
  resetBrowserManagerMocks(browserMocks)
  resetBrowserManagerState()
})
afterEach(() => resetBrowserManagerState())

describe('staged guest binding', () => {
  it('retains the old guest policy attachment so rollback can actually rebind it', () => {
    const guests = [createGuest(41), createGuest(42)]
    browserMocks.webContentsFromIdMock.mockImplementation(
      (id: number) => guests.find((guest) => guest.id === id) ?? null
    )
    for (const guest of guests) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the WebContents methods used by attachGuestPolicies are exercised by this fixture.
      browserManager.attachGuestPolicies(guest as never)
    }
    const binding = createBrowserClientPageGuestBinding(browserManager)
    binding.bind({ registration: registration(41, 1), browserProfileId: 'old-profile' })
    binding.bindReplacement!({ registration: registration(42, 2), browserProfileId: 'new-profile' })
    expect(browserManager.getGuestWebContentsId('page-a')).toBe(42)
    binding.release(registration(42, 2))
    binding.bind({ registration: registration(41, 1), browserProfileId: 'old-profile' })
    expect(browserManager.getGuestWebContentsId('page-a')).toBe(41)
    expect(browserManager.getSessionProfileIdForTab('page-a')).toBe('old-profile')
  })
})

function createGuest(id: number) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    getType: vi.fn(() => 'webview'),
    setBackgroundThrottling: browserMocks.guestSetBackgroundThrottlingMock,
    setWindowOpenHandler: browserMocks.guestSetWindowOpenHandlerMock,
    on: browserMocks.guestOnMock,
    off: browserMocks.guestOffMock,
    openDevTools: browserMocks.guestOpenDevToolsMock
  }
}
