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
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from '../browser-manager-test-harness'

const { webContentsFromIdMock } = browserMocks

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
})
