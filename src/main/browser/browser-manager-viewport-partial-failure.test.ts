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

import { browserManager } from './browser-manager'
import {
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'
import { createViewportGuestFactory } from './browser-manager-viewport-test-fixtures'

const makeGuest = createViewportGuestFactory(mocks)
const OVERRIDE = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true } as const

describe('browserManager viewport partial failure', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(mocks)
    resetBrowserManagerState()
  })

  it('keeps wheel routing active when follow-up setup fails after metrics apply', async () => {
    const { guest, debuggerSendCommand } = makeGuest(42421)
    debuggerSendCommand.mockImplementation((method: string) =>
      method === 'Emulation.setTouchEmulationEnabled'
        ? Promise.reject(new Error('touch setup failed'))
        : Promise.resolve(undefined)
    )
    mocks.webContentsFromIdMock.mockReturnValue(guest)
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'tab-partial-apply',
      webContentsId: guest.id as number,
      rendererWebContentsId
    })
    const renderer = { isDestroyed: vi.fn(() => false), send: vi.fn() }
    mocks.webContentsFromIdMock.mockImplementation((id: number) =>
      id === rendererWebContentsId ? renderer : guest
    )
    await expect(browserManager.setViewportOverride('tab-partial-apply', OVERRIDE)).resolves.toBe(
      false
    )
    browserManager.setViewportScrollState('tab-partial-apply', rendererWebContentsId, {
      scrollLeft: 0,
      scrollTop: 0,
      maxScrollLeft: 400,
      maxScrollTop: 300
    })

    const beforeMouseEvent = mocks.guestOnMock.mock.calls.findLast(
      ([event]) => event === 'before-mouse-event'
    )?.[1] as ((event: Electron.Event, mouse: Electron.MouseInputEvent) => void) | undefined
    expect(beforeMouseEvent).toBeDefined()
    const preventDefault = vi.fn()
    beforeMouseEvent?.(
      { preventDefault } as unknown as Electron.Event,
      {
        type: 'mouseWheel',
        x: 0,
        y: 0,
        modifiers: [],
        deltaX: 0,
        deltaY: 120
      } as Electron.MouseWheelInputEvent
    )
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(renderer.send).toHaveBeenCalledWith('ui:scrollBrowserPage', {
      browserPageId: 'tab-partial-apply',
      deltaX: 0,
      deltaY: 120
    })
  })

  it('keeps host panning available when metrics setup fails', async () => {
    const { guest, debuggerSendCommand } = makeGuest(42422)
    debuggerSendCommand.mockImplementation((method: string) =>
      method === 'Emulation.setDeviceMetricsOverride'
        ? Promise.reject(new Error('metrics setup failed'))
        : Promise.resolve(undefined)
    )
    mocks.webContentsFromIdMock.mockReturnValue(guest)
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'tab-metrics-failed',
      webContentsId: guest.id as number,
      rendererWebContentsId
    })
    const renderer = { isDestroyed: vi.fn(() => false), send: vi.fn() }
    mocks.webContentsFromIdMock.mockImplementation((id: number) =>
      id === rendererWebContentsId ? renderer : guest
    )

    await expect(browserManager.setViewportOverride('tab-metrics-failed', OVERRIDE)).resolves.toBe(
      false
    )
    browserManager.setViewportScrollState('tab-metrics-failed', rendererWebContentsId, {
      scrollLeft: 0,
      scrollTop: 0,
      maxScrollLeft: 400,
      maxScrollTop: 300
    })

    const beforeMouseEvent = mocks.guestOnMock.mock.calls.findLast(
      ([event]) => event === 'before-mouse-event'
    )?.[1] as ((event: Electron.Event, mouse: Electron.MouseInputEvent) => void) | undefined
    expect(beforeMouseEvent).toBeDefined()
    const preventDefault = vi.fn()
    beforeMouseEvent?.(
      { preventDefault } as unknown as Electron.Event,
      {
        type: 'mouseWheel',
        x: 0,
        y: 0,
        modifiers: [],
        deltaX: 0,
        deltaY: 120
      } as Electron.MouseWheelInputEvent
    )

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(renderer.send).toHaveBeenCalledWith('ui:scrollBrowserPage', {
      browserPageId: 'tab-metrics-failed',
      deltaX: 0,
      deltaY: 120
    })
  })
})
