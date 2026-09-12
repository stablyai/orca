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

const older = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
const newer = { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false }

describe('viewport request ordering across replacement', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('restores the newer queued preset after replacement during an older set', async () => {
    const old = makeGuest(4300)
    const next = makeGuest(4301)
    const tab = 'tab-newer-preset'
    webContentsFromIdMock.mockReturnValue(old.guest)
    browserManager.attachGuestPolicies(old.guest as never)
    browserManager.registerGuest({
      browserPageId: tab,
      webContentsId: 4300,
      rendererWebContentsId
    })
    let releaseTouch!: () => void
    let releaseUa!: () => void
    const touch = new Promise<void>((resolve) => {
      releaseTouch = resolve
    })
    const ua = new Promise<void>((resolve) => {
      releaseUa = resolve
    })
    old.debuggerSendCommand.mockImplementation((command: string) => {
      if (command === 'Emulation.setTouchEmulationEnabled') {
        return touch
      }
      if (command === 'Emulation.setUserAgentOverride') {
        return ua
      }
      return Promise.resolve()
    })
    const first = browserManager.setViewportOverride(tab, older)
    await flushViewportOps()
    expect(old.debuggerSendCommand).toHaveBeenCalledWith(
      'Emulation.setTouchEmulationEnabled',
      expect.anything()
    )
    const second = browserManager.setViewportOverride(tab, newer)
    releaseTouch()
    await flushViewportOps()
    expect(old.debuggerSendCommand).toHaveBeenCalledWith(
      'Emulation.setUserAgentOverride',
      expect.anything()
    )
    webContentsFromIdMock.mockReturnValue(next.guest)
    browserManager.attachGuestPolicies(next.guest as never)
    browserManager.registerGuest({
      browserPageId: tab,
      webContentsId: 4301,
      rendererWebContentsId
    })
    releaseUa()
    await Promise.all([first, second])
    await flushViewportOps()
    const metrics = next.debuggerSendCommand.mock.calls.filter(
      ([method]) => method === 'Emulation.setDeviceMetricsOverride'
    )
    expect(metrics.at(-1)?.[1]).toEqual(newer)
  })

  it('restores nothing when a queued clear is latest across replacement', async () => {
    const old = makeGuest(4302)
    const next = makeGuest(4303)
    const tab = 'tab-newer-clear'
    webContentsFromIdMock.mockReturnValue(old.guest)
    browserManager.attachGuestPolicies(old.guest as never)
    browserManager.registerGuest({
      browserPageId: tab,
      webContentsId: 4302,
      rendererWebContentsId
    })
    let releaseTouch!: () => void
    let releaseUa!: () => void
    const touch = new Promise<void>((resolve) => {
      releaseTouch = resolve
    })
    const ua = new Promise<void>((resolve) => {
      releaseUa = resolve
    })
    old.debuggerSendCommand.mockImplementation((command: string) => {
      if (command === 'Emulation.setTouchEmulationEnabled') {
        return touch
      }
      if (command === 'Emulation.setUserAgentOverride') {
        return ua
      }
      return Promise.resolve()
    })
    const first = browserManager.setViewportOverride(tab, older)
    await flushViewportOps()
    const clear = browserManager.setViewportOverride(tab, null)
    releaseTouch()
    await flushViewportOps()
    webContentsFromIdMock.mockReturnValue(next.guest)
    browserManager.attachGuestPolicies(next.guest as never)
    next.debuggerSendCommand.mockClear()
    browserManager.registerGuest({
      browserPageId: tab,
      webContentsId: 4303,
      rendererWebContentsId
    })
    releaseUa()
    await Promise.all([first, clear])
    await flushViewportOps()
    expect(next.debuggerSendCommand).not.toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      expect.anything()
    )
  })

  it('does not let a failed older clear restore over a newer queued preset', async () => {
    const old = makeGuest(4304)
    const next = makeGuest(4305)
    const tab = 'tab-failed-clear-newer-set'
    webContentsFromIdMock.mockReturnValue(old.guest)
    browserManager.attachGuestPolicies(old.guest as never)
    browserManager.registerGuest({
      browserPageId: tab,
      webContentsId: 4304,
      rendererWebContentsId
    })
    await browserManager.setViewportOverride(tab, older)
    let releaseClearUa!: () => void
    const clearUa = new Promise<void>((_resolve, reject) => {
      releaseClearUa = () => reject(new Error('debugger detached'))
    })
    old.debuggerSendCommand.mockImplementation(
      (command: string, params: { userAgent?: string } | undefined) =>
        command === 'Emulation.setUserAgentOverride' && params?.userAgent === ''
          ? clearUa
          : Promise.resolve()
    )
    const clear = browserManager.setViewportOverride(tab, null)
    await flushViewportOps()
    const second = browserManager.setViewportOverride(tab, newer)
    webContentsFromIdMock.mockReturnValue(next.guest)
    browserManager.attachGuestPolicies(next.guest as never)
    browserManager.registerGuest({
      browserPageId: tab,
      webContentsId: 4305,
      rendererWebContentsId
    })
    releaseClearUa()
    await Promise.all([clear, second])
    await flushViewportOps()
    const metrics = next.debuggerSendCommand.mock.calls.filter(
      ([method]) => method === 'Emulation.setDeviceMetricsOverride'
    )
    expect(metrics.at(-1)?.[1]).toEqual(newer)
  })
})
