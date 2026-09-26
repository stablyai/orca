import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  openPopupWithOriginBarMock: vi.fn()
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
  getBrowserProcessUserAgentIdentity: () => ({ mode: 'clean', userAgent: GUEST_CLEAN_UA })
}))

import { browserManager } from './browser-manager'
import {
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'
import {
  createViewportGuestFactory,
  flushViewportOps,
  GUEST_CLEAN_UA,
  type ViewportGuestHandle
} from './browser-manager-viewport-test-fixtures'

const makeGuest = createViewportGuestFactory(mocks)
const MOBILE = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true } as const
const LAPTOP = { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false } as const

function registerGuest(id: number, browserPageId: string): ViewportGuestHandle {
  const handle = makeGuest(id)
  mocks.webContentsFromIdMock.mockReturnValue(handle.guest)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the viewport fixture implements every WebContents member these paths touch.
  browserManager.attachGuestPolicies(handle.guest as never)
  browserManager.registerGuest({ browserPageId, webContentsId: id, rendererWebContentsId })
  return handle
}

function userAgentWrites(
  debuggerSendCommand: ViewportGuestHandle['debuggerSendCommand']
): string[] {
  return debuggerSendCommand.mock.calls.flatMap(([method, params]) =>
    method === 'Emulation.setUserAgentOverride' && typeof params?.userAgent === 'string'
      ? [params.userAgent]
      : []
  )
}

function startNavigation(url: string): void {
  const didStartNavigation = mocks.guestOnMock.mock.calls.findLast(
    ([event]) => event === 'did-start-navigation'
  )?.[1]
  expect(didStartNavigation).toBeTypeOf('function')
  didStartNavigation(null, url, false, true)
}

// Regression for #22749: leaving a mobile preset must actually turn touch emulation off, or the
// guest keeps (hover: none) / coarse pointer and loses every hover style.
describe('browserManager viewport touch reset', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(mocks)
    resetBrowserManagerState()
  })

  it.each([
    ['a desktop preset', LAPTOP],
    ['no preset', null]
  ])('disables touch emulation when switching from mobile to %s', async (_label, next) => {
    const { debuggerSendCommand } = registerGuest(52001, 'tab-touch-reset')
    await expect(browserManager.setViewportOverride('tab-touch-reset', MOBILE)).resolves.toBe(true)
    debuggerSendCommand.mockClear()

    await expect(browserManager.setViewportOverride('tab-touch-reset', next)).resolves.toBe(true)

    expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', {
      enabled: false
    })
    const writes = userAgentWrites(debuggerSendCommand)
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.at(-1)).not.toContain('iPhone')

    // A later navigation must not re-install the mobile UA behind the switch.
    debuggerSendCommand.mockClear()
    startNavigation('https://example.com/next')
    await flushViewportOps()
    expect(userAgentWrites(debuggerSendCommand).some((ua) => ua.includes('iPhone'))).toBe(false)
  })
})
