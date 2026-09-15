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

const { webContentsFromIdMock, guestOnMock } = browserMocks
const makeGuest = createViewportGuestFactory(browserMocks)

describe('browserManager viewport debugger reattachment', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('restores the standing viewport after debugger detach without a reconnect timer', async () => {
    vi.useFakeTimers()
    const { guest, debuggerAttach, debuggerIsAttached, debuggerOn, debuggerSendCommand } =
      makeGuest(4250)
    debuggerAttach.mockImplementation(() => {
      debuggerIsAttached.mockReturnValue(true)
    })
    webContentsFromIdMock.mockReturnValue(guest)
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'tab-detach-restore',
      webContentsId: guest.id as number,
      rendererWebContentsId
    })
    await browserManager.setViewportOverride('tab-detach-restore', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true
    })

    debuggerSendCommand.mockClear()
    debuggerAttach.mockClear()
    debuggerIsAttached.mockReturnValue(false)
    const detachHandler = debuggerOn.mock.calls.find(([event]) => event === 'detach')?.[1] as
      | (() => void)
      | undefined
    detachHandler?.()
    await flushViewportOps()

    expect(debuggerAttach).toHaveBeenCalledWith('1.3')
    expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true
    })
    expect(vi.getTimerCount()).toBe(0)
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
    const clearPromise = browserManager.setViewportOverride('tab-clear-during-reattach', null)
    await flushViewportOps()
    expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride', {})
    detachHandler?.()
    await flushViewportOps()
    releaseClearMetrics()
    await clearPromise
    await flushViewportOps()

    expect(debuggerSendCommand).not.toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      expect.anything()
    )
  })

  it('restores the standing viewport when a registered webview guest is replaced', async () => {
    const oldGuest = makeGuest(4252)
    const newGuest = makeGuest(4253)
    webContentsFromIdMock.mockReturnValue(oldGuest.guest)
    browserManager.attachGuestPolicies(oldGuest.guest as never)
    browserManager.registerGuest({
      browserPageId: 'tab-replaced-webview',
      webContentsId: oldGuest.guest.id as number,
      rendererWebContentsId
    })
    await browserManager.setViewportOverride('tab-replaced-webview', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true
    })

    webContentsFromIdMock.mockReturnValue(newGuest.guest)
    browserManager.attachGuestPolicies(newGuest.guest as never)
    newGuest.debuggerSendCommand.mockClear()
    browserManager.registerGuest({
      browserPageId: 'tab-replaced-webview',
      webContentsId: newGuest.guest.id as number,
      rendererWebContentsId
    })
    await flushViewportOps()

    expect(newGuest.debuggerSendCommand).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true
      }
    )
  })

  it('restores the standing viewport when an offscreen guest is replaced', async () => {
    const oldGuest = makeGuest(4254)
    const newGuest = makeGuest(4255)
    ;(oldGuest.guest.getType as ReturnType<typeof vi.fn>).mockReturnValue('window')
    ;(newGuest.guest.getType as ReturnType<typeof vi.fn>).mockReturnValue('window')
    webContentsFromIdMock.mockReturnValue(oldGuest.guest)
    browserManager.registerOffscreenGuest({
      browserPageId: 'tab-replaced-offscreen',
      webContentsId: oldGuest.guest.id as number
    })
    await browserManager.setViewportOverride('tab-replaced-offscreen', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false
    })

    webContentsFromIdMock.mockReturnValue(newGuest.guest)
    newGuest.debuggerSendCommand.mockClear()
    browserManager.registerOffscreenGuest({
      browserPageId: 'tab-replaced-offscreen',
      webContentsId: newGuest.guest.id as number
    })
    await flushViewportOps()

    expect(newGuest.debuggerSendCommand).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false
      }
    )
  })

  it('does not attach on detach or DevTools close when no viewport preset is standing', async () => {
    const { guest, debuggerAttach, debuggerIsAttached, debuggerOn, debuggerSendCommand } =
      makeGuest(4256)
    webContentsFromIdMock.mockReturnValue(guest)
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'tab-no-preset-detach',
      webContentsId: guest.id as number,
      rendererWebContentsId
    })
    debuggerAttach.mockClear()
    debuggerSendCommand.mockClear()
    debuggerIsAttached.mockReturnValue(false)
    const detachHandler = debuggerOn.mock.calls.find(([event]) => event === 'detach')?.[1] as
      | (() => void)
      | undefined
    const closedHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'devtools-closed'
    )?.[1] as (() => void) | undefined
    detachHandler?.()
    closedHandler?.()
    await flushViewportOps()

    expect(debuggerAttach).not.toHaveBeenCalled()
    expect(debuggerSendCommand).not.toHaveBeenCalled()
  })

  it('restores the standing viewport on DevTools close, not while DevTools is open', async () => {
    vi.useFakeTimers()
    const {
      guest,
      debuggerAttach,
      debuggerIsAttached,
      debuggerOn,
      debuggerSendCommand,
      isDevToolsOpened
    } = makeGuest(4260)
    debuggerAttach.mockImplementation(() => {
      throw new Error('Another debugger is already attached')
    })
    webContentsFromIdMock.mockReturnValue(guest)
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'tab-devtools-restore',
      webContentsId: guest.id as number,
      rendererWebContentsId
    })
    debuggerAttach.mockImplementation(() => {
      debuggerIsAttached.mockReturnValue(true)
    })
    await browserManager.setViewportOverride('tab-devtools-restore', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true
    })

    debuggerSendCommand.mockClear()
    debuggerAttach.mockClear()
    debuggerAttach.mockImplementation(() => {
      throw new Error('Another debugger is already attached')
    })
    debuggerIsAttached.mockReturnValue(false)
    isDevToolsOpened.mockReturnValue(true)
    const detachHandler = debuggerOn.mock.calls.find(([event]) => event === 'detach')?.[1] as
      | (() => void)
      | undefined
    const closedHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'devtools-closed'
    )?.[1] as (() => void) | undefined
    // Electron: debugger.detach fires when DevTools is invoked, not when it closes.
    detachHandler?.()
    await flushViewportOps()
    expect(debuggerAttach).not.toHaveBeenCalled()
    expect(debuggerSendCommand).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    isDevToolsOpened.mockReturnValue(false)
    debuggerAttach.mockImplementation(() => {
      debuggerIsAttached.mockReturnValue(true)
    })
    closedHandler?.()
    await flushViewportOps()

    expect(debuggerAttach).toHaveBeenCalledWith('1.3')
    expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not apply an in-flight set to a replacement guest and restores on the new guest', async () => {
    const oldGuest = makeGuest(4257)
    const newGuest = makeGuest(4258)
    webContentsFromIdMock.mockReturnValue(oldGuest.guest)
    browserManager.attachGuestPolicies(oldGuest.guest as never)
    browserManager.registerGuest({
      browserPageId: 'tab-replace-during-set',
      webContentsId: oldGuest.guest.id as number,
      rendererWebContentsId
    })

    let releaseTouch!: () => void
    const touchGate = new Promise<void>((resolve) => {
      releaseTouch = resolve
    })
    oldGuest.debuggerSendCommand.mockImplementation((command: string) =>
      command === 'Emulation.setTouchEmulationEnabled' ? touchGate : Promise.resolve()
    )

    const setPromise = browserManager.setViewportOverride('tab-replace-during-set', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true
    })
    await flushViewportOps()
    expect(oldGuest.debuggerSendCommand).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({ width: 390, height: 844 })
    )

    webContentsFromIdMock.mockReturnValue(newGuest.guest)
    browserManager.attachGuestPolicies(newGuest.guest as never)
    newGuest.debuggerSendCommand.mockClear()
    browserManager.registerGuest({
      browserPageId: 'tab-replace-during-set',
      webContentsId: newGuest.guest.id as number,
      rendererWebContentsId
    })
    releaseTouch()
    await expect(setPromise).resolves.toBe(false)
    await flushViewportOps()

    expect(oldGuest.debuggerSendCommand).not.toHaveBeenCalledWith(
      'Emulation.setUserAgentOverride',
      expect.anything()
    )
    expect(newGuest.debuggerSendCommand).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true
      }
    )
  })

  it('rejects the caller when a viewport op throws before CDP handling', async () => {
    const { guest } = makeGuest(4259)
    webContentsFromIdMock.mockReturnValue(guest)
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'tab-throw-before-cdp',
      webContentsId: guest.id as number,
      rendererWebContentsId
    })

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    webContentsFromIdMock.mockImplementation(() => {
      throw new Error('guest lookup failed')
    })
    try {
      await expect(
        browserManager.setViewportOverride('tab-throw-before-cdp', {
          width: 1024,
          height: 768,
          deviceScaleFactor: 1,
          mobile: false
        })
      ).rejects.toThrow('guest lookup failed')
      await flushViewportOps()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    webContentsFromIdMock.mockReturnValue(guest)
    await expect(
      browserManager.setViewportOverride('tab-throw-before-cdp', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
    ).resolves.toBe(true)
  })
})
