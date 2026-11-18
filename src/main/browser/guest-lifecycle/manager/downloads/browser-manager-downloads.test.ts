import { join } from 'node:path'
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

vi.mock('../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from '../browser-manager'
import {
  createDownloadItem,
  getDownloadItemEventHandler,
  guestNavigationMethods,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from '../browser-manager-test-harness'

const {
  guestOffMock,
  guestOnMock,
  guestSetBackgroundThrottlingMock,
  guestSetWindowOpenHandlerMock,
  guestOpenDevToolsMock,
  webContentsFromIdMock
} = browserMocks

describe('browserManager', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("saves the page's next download where an agent asked and reports when it finishes", async () => {
    webContentsFromIdMock.mockReturnValue(null)
    const agentPath = join('/work', 'out', 'report.csv')
    const claim = browserManager.claimNextDownload(414, agentPath)

    const claimed = createDownloadItem()
    browserManager.handleGuestWillDownload({ guestWebContentsId: 414, item: claimed })
    await expect(claim.started).resolves.toBe(true)
    expect(claimed.setSavePath).toHaveBeenCalledWith(agentPath)

    const doneEvent = { preventDefault: () => {}, defaultPrevented: false }
    getDownloadItemEventHandler(claimed, 'once', 'done')?.(doneEvent, 'completed')
    await expect(claim.finished).resolves.toMatchObject({
      status: 'completed',
      savePath: agentPath
    })

    const next = createDownloadItem()
    browserManager.handleGuestWillDownload({ guestWebContentsId: 414, item: next })
    expect(next.setSavePath).toHaveBeenCalledWith(join('/downloads', 'report.csv'))
    claim.release()
  })

  it("hands a tab's unclaimed download to the standing claim, after an agent's own claim", async () => {
    const guest = {
      id: 415,
      ...guestNavigationMethods(),
      getURL: vi.fn(() => 'https://console.cloud.google.com/auth/clients'),
      isDestroyed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === guest.id
        ? guest
        : id === rendererWebContentsId
          ? { isDestroyed: vi.fn(() => false), send: vi.fn() }
          : null
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements the guest members registration and download policy use.
    browserManager.attachGuestPolicies(guest as unknown as Electron.WebContents)
    browserManager.registerGuest({
      browserPageId: 'setup-page',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    const finish = vi.fn()
    const keyPath = join('/private', 'key.json')
    // Claims only from the page's own document, as the resolver is told it.
    browserManager.setStandingDownloadClaim(({ browserTabId, filename, documentUrl }) =>
      browserTabId === 'setup-page' &&
      filename === 'client_secret_1.json' &&
      documentUrl === 'https://console.cloud.google.com/auth/clients'
        ? { savePath: keyPath, finish }
        : null
    )
    try {
      const agentPath = join('/work', 'mine.json')
      const claim = browserManager.claimNextDownload(guest.id, agentPath)
      const claimed = createDownloadItem({ getFilename: vi.fn(() => 'client_secret_1.json') })
      browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item: claimed })
      expect(claimed.setSavePath).toHaveBeenCalledWith(agentPath)
      claim.release()

      const key = createDownloadItem({ getFilename: vi.fn(() => 'client_secret_1.json') })
      browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item: key })
      expect(key.setSavePath).toHaveBeenCalledWith(keyPath)
      const done: Electron.Event = { preventDefault: () => {}, defaultPrevented: false }
      getDownloadItemEventHandler(key, 'once', 'done')?.(done, 'completed')
      expect(finish).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed', savePath: keyPath })
      )

      guest.getURL.mockReturnValue('https://example.com/unrelated')
      const elsewhere = createDownloadItem({ getFilename: vi.fn(() => 'client_secret_1.json') })
      browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item: elsewhere })
      expect(elsewhere.setSavePath).toHaveBeenCalledWith(join('/downloads', 'client_secret_1.json'))

      const other = createDownloadItem()
      browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item: other })
      expect(other.setSavePath).toHaveBeenCalledWith(join('/downloads', 'report.csv'))
    } finally {
      browserManager.setStandingDownloadClaim(null)
    }
  })
})
