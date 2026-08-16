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
import {
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'
import {
  createViewportGuestFactory,
  flushViewportOps
} from './browser-manager-viewport-test-fixtures'

const { webContentsFromIdMock } = browserMocks
const makeGuest = createViewportGuestFactory(browserMocks)

describe('browserManager viewport debugger reattachment', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a queued clear authoritative across debugger reattachment', async () => {
    const { guest, debuggerAttach, debuggerIsAttached, debuggerOn, debuggerSendCommand } =
      makeGuest(4251)
    debuggerAttach.mockImplementation(() => {
      debuggerIsAttached.mockReturnValue(true)
    })
    webContentsFromIdMock.mockReturnValue(guest)
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'tab-clear-during-reattach',
      webContentsId: guest.id as number,
      rendererWebContentsId
    })
    await browserManager.setViewportOverride('tab-clear-during-reattach', {
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false
    })

    let releaseClearMetrics!: () => void
    const clearMetrics = new Promise<void>((resolve) => {
      releaseClearMetrics = resolve
    })
    debuggerSendCommand.mockClear()
    debuggerSendCommand.mockImplementation((command) =>
      command === 'Emulation.clearDeviceMetricsOverride' ? clearMetrics : Promise.resolve()
    )
    const detachHandler = debuggerOn.mock.calls.find(([event]) => event === 'detach')?.[1] as
      | (() => void)
      | undefined
    debuggerIsAttached.mockReturnValue(false)
    detachHandler?.()
    const clearPromise = browserManager.setViewportOverride('tab-clear-during-reattach', null)
    await flushViewportOps()
    expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride', {})

    vi.advanceTimersByTime(500)
    releaseClearMetrics()
    await clearPromise
    await flushViewportOps()

    expect(debuggerSendCommand).not.toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      expect.anything()
    )
  })
})
