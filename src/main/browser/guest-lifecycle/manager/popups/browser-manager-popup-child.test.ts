import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const browserMocks = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => '/downloads'),
  menuBuildFromTemplateMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestOpenDevToolsMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 })),
  shellOpenExternalMock: vi.fn(),
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

vi.mock('../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from '../browser-manager'
import {
  createDownloadItem,
  guestNavigationMethods,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from '../browser-manager-test-harness'

const { webContentsFromIdMock } = browserMocks

let didCreateWindow: (window: { webContents: unknown }) => void = () => {}
const fakeGuest = (id: number) => ({
  ...guestNavigationMethods(),
  id,
  isDestroyed: vi.fn(() => false),
  isCurrentlyAudible: vi.fn(() => false),
  getType: vi.fn(() => 'webview'),
  setWindowOpenHandler: vi.fn(),
  downloadURL: vi.fn(),
  on: vi.fn((event: string, listener: (window: { webContents: unknown }) => void) => {
    if (event === 'did-create-window') {
      didCreateWindow = listener
    }
  }),
  off: vi.fn(),
  once: vi.fn((_event: string, listener: () => void) => listener()),
  close: vi.fn()
})

describe('browserManager popup child policies', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("saves a popup page's agent download to its path and refuses a second claim on the tab", async () => {
    const opener = fakeGuest(406)
    const popup = fakeGuest(4060)
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === opener.id ? opener : id === popup.id ? popup : null
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the policy reads only the fake's listed members.
    browserManager.attachGuestPolicies(opener as unknown as Electron.WebContents)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: opener.id,
      rendererWebContentsId
    })
    didCreateWindow({ webContents: popup })

    const claim = browserManager.claimNextDownload(popup.id, '/work/out/receipt.pdf')
    expect(() => browserManager.claimNextDownload(opener.id, '/work/out/other.pdf')).toThrow(
      'Another download is already waiting'
    )
    const item = createDownloadItem()
    browserManager.handleGuestWillDownload({ guestWebContentsId: popup.id, item })

    expect(item.setSavePath).toHaveBeenCalledWith('/work/out/receipt.pdf')
    await expect(claim.started).resolves.toBe(true)
  })
})
