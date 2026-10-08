import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const mocks = vi.hoisted(() => ({
  appGetPath: vi.fn(() => '/downloads'),
  fromWebContents: vi.fn(),
  buildMenu: vi.fn(),
  guestOff: vi.fn(),
  guestOn: vi.fn(),
  setBackgroundThrottling: vi.fn(),
  setWindowOpenHandler: vi.fn(),
  openDevTools: vi.fn(),
  fromId: vi.fn(),
  cursor: vi.fn(() => ({ x: 0, y: 0 }))
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.appGetPath },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: mocks.buildMenu },
  screen: { getCursorScreenPoint: mocks.cursor },
  webContents: { fromId: mocks.fromId }
}))
vi.mock('./popup-origin-bar-window', () => ({ openPopupWithOriginBar: vi.fn() }))
vi.mock('./browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({
    mode: 'clean',
    userAgent: 'Mozilla/5.0 Chrome/134.0.0.0'
  })
}))

import { browserCaptureIdle } from './browser-capture-idle'
import { browserManager } from './browser-manager'
import { rendererWebContentsId, resetBrowserManagerState } from './browser-manager-test-harness'
import {
  createViewportGuestFactory,
  flushViewportOps
} from './browser-manager-viewport-test-fixtures'

const makeGuest = createViewportGuestFactory({
  appGetPathMock: mocks.appGetPath,
  shellOpenExternalMock: vi.fn(),
  browserWindowFromWebContentsMock: mocks.fromWebContents,
  menuBuildFromTemplateMock: mocks.buildMenu,
  guestOffMock: mocks.guestOff,
  guestOnMock: mocks.guestOn,
  guestSetBackgroundThrottlingMock: mocks.setBackgroundThrottling,
  guestSetWindowOpenHandlerMock: mocks.setWindowOpenHandler,
  guestOpenDevToolsMock: mocks.openDevTools,
  webContentsFromIdMock: mocks.fromId,
  screenGetCursorScreenPointMock: mocks.cursor,
  openPopupWithOriginBarMock: vi.fn(),
  processUserAgent: 'Mozilla/5.0 Chrome/134.0.0.0'
})

describe('browser manager viewport capture admission', () => {
  beforeEach(() => {
    resetBrowserManagerState()
    mocks.fromId.mockReset()
  })

  it.each([false, true])(
    'applies queued presets in order after an owned capture settles (capture fails: %s)',
    async (captureFails) => {
      const { guest, debuggerSendCommand } = makeGuest(4240)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared viewport guest fixture implements the policy and registration APIs used in this test.
      const contents = guest as unknown as WebContents
      mocks.fromId.mockReturnValue(guest)
      browserManager.attachGuestPolicies(contents)
      browserManager.registerGuest({
        browserPageId: 'reserved-viewport',
        webContentsId: contents.id,
        rendererWebContentsId
      })
      const lease = await browserCaptureIdle.reserve(guest)
      let finishCapture = (): void => {}
      const captureGate = new Promise<void>((resolve) => {
        finishCapture = resolve
      })
      const capture = browserCaptureIdle
        .runReservedCapture(guest, lease, async () => {
          await captureGate
          if (captureFails) {
            throw new Error('owned capture failed')
          }
        })
        .catch(() => {})
      const firstPreset = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }
      const finalPreset = { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }
      const first = browserManager.setViewportOverride('reserved-viewport', firstPreset)
      const final = browserManager.setViewportOverride('reserved-viewport', finalPreset)
      let settled = false
      void final.then(() => {
        settled = true
      })
      try {
        await flushViewportOps()
        expect(debuggerSendCommand).not.toHaveBeenCalled()
        expect(settled).toBe(false)
      } finally {
        finishCapture()
        await capture
        lease.release()
      }

      await expect(Promise.all([first, final])).resolves.toEqual([true, true])
      expect(
        debuggerSendCommand.mock.calls.filter(
          ([method]) => method === 'Emulation.setDeviceMetricsOverride'
        )
      ).toEqual([
        ['Emulation.setDeviceMetricsOverride', firstPreset],
        ['Emulation.setDeviceMetricsOverride', finalPreset]
      ])
      expect(debuggerSendCommand).toHaveBeenLastCalledWith('Emulation.setUserAgentOverride', {
        userAgent: ''
      })
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', {
        enabled: false
      })
    }
  )

  it('rejects a queued preset when the tab guest changes during the reservation', async () => {
    const original = makeGuest(4241)
    const replacement = makeGuest(4242)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both shared fixtures implement the guest registration APIs used here.
    const contents = original.guest as unknown as WebContents
    mocks.fromId.mockReturnValue(original.guest)
    browserManager.attachGuestPolicies(contents)
    browserManager.registerGuest({
      browserPageId: 'replaced-viewport',
      webContentsId: contents.id,
      rendererWebContentsId
    })
    const lease = await browserCaptureIdle.reserve(original.guest)
    const pending = browserManager.setViewportOverride('replaced-viewport', {
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      mobile: true
    })
    try {
      await flushViewportOps()
      mocks.fromId.mockReturnValue(replacement.guest)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared replacement fixture implements attachGuestPolicies APIs.
      browserManager.attachGuestPolicies(replacement.guest as unknown as WebContents)
      expect(
        browserManager.registerGuest({
          browserPageId: 'replaced-viewport',
          webContentsId: 4242,
          rendererWebContentsId
        })
      ).toBe(true)
    } finally {
      lease.release()
    }
    await expect(pending).resolves.toBe(false)
    expect(original.debuggerSendCommand).not.toHaveBeenCalled()
    expect(replacement.debuggerSendCommand).not.toHaveBeenCalled()
  })

  it('finishes touch emulation before a mid-flight reservation can move the guest', async () => {
    const { guest, debuggerSendCommand } = makeGuest(4239)
    let releaseMetrics = (): void => {}
    const metricsGate = new Promise<void>((resolve) => {
      releaseMetrics = resolve
    })
    debuggerSendCommand.mockImplementation((method: string) =>
      method === 'Emulation.setDeviceMetricsOverride' ? metricsGate : Promise.resolve(undefined)
    )
    mocks.fromId.mockReturnValue(guest)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared viewport guest fixture implements the policy and registration APIs used in this test.
    const contents = guest as unknown as WebContents
    browserManager.attachGuestPolicies(contents)
    browserManager.registerGuest({
      browserPageId: 'tab-admitted-viewport',
      webContentsId: contents.id,
      rendererWebContentsId
    })

    const viewport = browserManager.setViewportOverride('tab-admitted-viewport', {
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      mobile: true
    })
    await flushViewportOps()
    const reservation = browserCaptureIdle.reserve(guest)
    releaseMetrics()
    await viewport

    expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5
    })
    const lease = await reservation
    lease.release()
  })
})
