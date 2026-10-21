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
  openPopupWithOriginBarMock: vi.fn(),
  processUserAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
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
  getBrowserProcessUserAgentIdentity: () => ({ mode: 'clean', userAgent: mocks.processUserAgent })
}))

import { browserManager } from './browser-manager'
import {
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'
import { createViewportGuestFactory } from './browser-manager-viewport-test-fixtures'

const makeGuest = createViewportGuestFactory(mocks)
const PHONE = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true } as const

const metricsWrites = (sendCommand: ReturnType<typeof vi.fn>): unknown[][] =>
  sendCommand.mock.calls.filter(([method]) => method === 'Emulation.setDeviceMetricsOverride')

describe('browserManager viewport on a guest whose renderer crashed', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(mocks)
    resetBrowserManagerState()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('never resizes the dead guest, and applies the preset once the page reloads', async () => {
    const { guest, debuggerSendCommand, setRendererCrashed } = makeGuest(42501)
    mocks.webContentsFromIdMock.mockReturnValue(guest)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the viewport fixture implements every WebContents member these paths touch.
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'tab-crashed',
      webContentsId: 42501,
      rendererWebContentsId
    })

    // Chromium would segfault the main process on this write (its view is gone with the renderer).
    setRendererCrashed(true)
    await expect(browserManager.setViewportOverride('tab-crashed', PHONE)).resolves.toBe(false)
    expect(metricsWrites(debuggerSendCommand)).toEqual([])

    // The reloaded page's dom-ready reapplies the store's preset.
    setRendererCrashed(false)
    await expect(browserManager.setViewportOverride('tab-crashed', PHONE)).resolves.toBe(true)
    expect(metricsWrites(debuggerSendCommand)).toEqual([
      ['Emulation.setDeviceMetricsOverride', PHONE]
    ])
  })
})
