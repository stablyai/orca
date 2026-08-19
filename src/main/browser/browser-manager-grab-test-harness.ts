import { vi, type Mock } from 'vitest'
import { browserManager } from './browser-manager'

export const GRAB_RENDERER_WEB_CONTENTS_ID = 5001
export const GRAB_GUEST_WEB_CONTENTS_ID = 101

// Why: every grab test file must declare its own vi.hoisted mock bundle (vi.mock
// factories cannot close over imports), so this is the shape they all produce.
export type GrabTestMocks = {
  webContentsFromIdMock: Mock
  guestOnMock: Mock
  guestOffMock: Mock
  guestSetBackgroundThrottlingMock: Mock
  guestSetWindowOpenHandlerMock: Mock
  guestExecuteJavaScriptMock: Mock
  guestExecuteJavaScriptInIsolatedWorldMock: Mock
  guestIsDestroyedMock: Mock<() => boolean>
  guestGetZoomFactorMock: Mock<() => number>
  guestCapturePageMock: Mock
  menuBuildFromTemplateMock: Mock
  rendererSendMock: Mock
  rendererIsDestroyedMock: Mock<() => boolean>
}

export function makeGuest(id: number, mocks: GrabTestMocks): Electron.WebContents {
  return {
    id,
    isDestroyed: mocks.guestIsDestroyedMock,
    getType: vi.fn(() => 'webview'),
    setBackgroundThrottling: mocks.guestSetBackgroundThrottlingMock,
    setWindowOpenHandler: mocks.guestSetWindowOpenHandlerMock,
    on: mocks.guestOnMock,
    off: mocks.guestOffMock,
    openDevTools: vi.fn(),
    executeJavaScript: mocks.guestExecuteJavaScriptMock,
    executeJavaScriptInIsolatedWorld: mocks.guestExecuteJavaScriptInIsolatedWorldMock,
    getZoomFactor: mocks.guestGetZoomFactorMock,
    capturePage: mocks.guestCapturePageMock,
    getURL: vi.fn(() => 'https://example.com/')
  } as unknown as Electron.WebContents
}

export function routeWebContentsIds(
  mocks: GrabTestMocks,
  guestsById: Record<number, Electron.WebContents>
): void {
  mocks.webContentsFromIdMock.mockImplementation((id: number) => {
    const guest = guestsById[id]
    if (guest) {
      return guest
    }
    if (id === GRAB_RENDERER_WEB_CONTENTS_ID) {
      return {
        isDestroyed: mocks.rendererIsDestroyedMock,
        send: mocks.rendererSendMock
      }
    }
    return null
  })
}

export function resetGrabTestEnvironment(mocks: GrabTestMocks): Electron.WebContents {
  vi.clearAllMocks()
  mocks.guestIsDestroyedMock.mockReturnValue(false)
  mocks.guestExecuteJavaScriptMock.mockResolvedValue(true)
  mocks.guestExecuteJavaScriptInIsolatedWorldMock.mockResolvedValue(true)
  browserManager.unregisterAll()
  browserManager.setSettingsResolver(() => ({}))

  const guest = makeGuest(GRAB_GUEST_WEB_CONTENTS_ID, mocks)
  routeWebContentsIds(mocks, { [GRAB_GUEST_WEB_CONTENTS_ID]: guest })

  browserManager.attachGuestPolicies(guest)
  browserManager.registerGuest({
    browserPageId: 'tab-1',
    webContentsId: GRAB_GUEST_WEB_CONTENTS_ID,
    rendererWebContentsId: GRAB_RENDERER_WEB_CONTENTS_ID
  })
  return guest
}
