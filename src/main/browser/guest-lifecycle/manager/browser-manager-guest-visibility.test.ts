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

vi.mock('../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from './browser-manager'

import {
  guestNavigationMethods,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'

const { webContentsFromIdMock } = browserMocks

describe('browserManager', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('cleans capture ownership after the renderer fails to acquire it', () => {
    vi.useFakeTimers()
    const guest = {
      ...guestNavigationMethods(),
      id: 1711,
      isDestroyed: vi.fn(() => false),
      isCrashed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: vi.fn(),
      capturePage: vi.fn(async () => null),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      openDevTools: vi.fn()
    }
    const renderer = {
      id: rendererWebContentsId,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      capturePage: vi.fn(async () => null)
    }
    webContentsFromIdMock.mockImplementation((id: number) => (id === guest.id ? guest : renderer))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this guest provides the policy and registration members exercised here.
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'page-failure',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    renderer.setBackgroundThrottling.mockImplementationOnce(() => {
      throw new Error('renderer unavailable')
    })
    expect(() => browserManager.holdPaintForCapture(guest.id)).toThrow('renderer unavailable')
    vi.runAllTimers()
    expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])

    renderer.send.mockClear()
    const releaseNext = browserManager.holdPaintForCapture(guest.id)
    expect(renderer.send.mock.calls).toEqual([
      ['browser:capturePaintHold', { browserPageId: 'page-failure', held: true }]
    ])
    releaseNext()
    vi.runAllTimers()
    expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true], [false], [true]])
  })
})
