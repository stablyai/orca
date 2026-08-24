import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from './browser-manager'
import { resetBrowserManagerMocks, resetBrowserManagerState } from './browser-manager-test-harness'

const {
  guestOffMock,
  guestOnMock,
  guestSetBackgroundThrottlingMock,
  guestSetWindowOpenHandlerMock,
  guestOpenDevToolsMock
} = browserMocks

type RenderProcessGoneHandler = (
  event: unknown,
  details: { reason: string; exitCode: number }
) => void

function makeGuest(id: number, rendererProcessId?: number) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    getProcessId: vi.fn(() => {
      if (rendererProcessId === undefined) {
        throw new Error('Object has been destroyed')
      }
      return rendererProcessId
    }),
    getType: vi.fn(() => 'webview'),
    setBackgroundThrottling: guestSetBackgroundThrottlingMock,
    setWindowOpenHandler: guestSetWindowOpenHandlerMock,
    on: guestOnMock,
    off: guestOffMock,
    openDevTools: guestOpenDevToolsMock
  }
}

function attachedRenderProcessGoneHandler(): RenderProcessGoneHandler | undefined {
  return guestOnMock.mock.calls.find(([event]) => event === 'render-process-gone')?.[1] as
    | RenderProcessGoneHandler
    | undefined
}

describe('browserManager guest crash reporting (#15052)', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  it('reports a guest renderer death instead of leaving zero trace', () => {
    browserManager.attachGuestPolicies(makeGuest(104, 4) as never)

    const handler = attachedRenderProcessGoneHandler()
    // Pre-fix: every render-process-gone listener on a guest is cleanup-only,
    // so nothing here can ever reach the crash recorder.
    expect(handler).toBeTypeOf('function')

    const reporter = vi.fn()
    browserManager.setGuestRendererGoneReporter(reporter)
    const details = { reason: 'killed', exitCode: 1 }
    handler?.({}, details)
    expect(reporter).toHaveBeenCalledExactlyOnceWith(details, 104, 'browser-guest', 4)
  })

  it('labels popup child windows distinctly from the primary guest', () => {
    const reporter = vi.fn()
    browserManager.setGuestRendererGoneReporter(reporter)
    browserManager.attachGuestPolicies(
      makeGuest(205, 4) as never,
      { browserTabId: 'browser-1', rootGuestWebContentsId: 104 } as never
    )

    const handler = attachedRenderProcessGoneHandler()
    expect(handler).toBeTypeOf('function')
    handler?.({}, { reason: 'crashed', exitCode: 5 })
    expect(reporter).toHaveBeenCalledExactlyOnceWith(
      { reason: 'crashed', exitCode: 5 },
      205,
      'browser-popup',
      4
    )
  })

  it('still reports when the renderer process identity is unreadable', () => {
    // makeGuest with no process id throws from getProcessId, modeling a guest
    // torn down mid-event; the death must reach the reporter with an unknown
    // identity instead of being dropped.
    browserManager.attachGuestPolicies(makeGuest(104) as never)

    const reporter = vi.fn()
    browserManager.setGuestRendererGoneReporter(reporter)
    const details = { reason: 'killed', exitCode: 1 }
    attachedRenderProcessGoneHandler()?.({}, details)
    expect(reporter).toHaveBeenCalledExactlyOnceWith(details, 104, 'browser-guest', undefined)
  })

  it('stops reporting after guest teardown removes the policy listeners', () => {
    const reporter = vi.fn()
    browserManager.setGuestRendererGoneReporter(reporter)
    browserManager.attachGuestPolicies(makeGuest(104) as never)

    const handler = attachedRenderProcessGoneHandler()
    expect(handler).toBeTypeOf('function')
    browserManager.unregisterAll()

    expect(guestOffMock.mock.calls.some(([event]) => event === 'render-process-gone')).toBe(true)
  })
})
