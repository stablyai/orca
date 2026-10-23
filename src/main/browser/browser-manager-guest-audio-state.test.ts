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
import {
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'

const { guestOnMock, webContentsFromIdMock } = browserMocks

describe('browser guest audio state', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  // The renderer re-applies a tab's mute on each registration report and clears the
  // speaker on the unregister report, so neither may be skipped.
  it('reports on registration, forwards changes, and reports silence on unregister', () => {
    const rendererSend = vi.fn()
    const guest = {
      id: 301,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      isCurrentlyAudible: vi.fn(() => true),
      setBackgroundThrottling: browserMocks.guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: browserMocks.guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: browserMocks.guestOffMock,
      openDevTools: browserMocks.guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === guest.id
        ? guest
        : id === rendererWebContentsId
          ? { isDestroyed: () => false, send: rendererSend }
          : null
    )
    browserManager.attachGuestPolicies(guest as never)
    const audioStateHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'audio-state-changed'
    )?.[1]
    const onAudioStateChanged = (event: { audible: boolean }): void => audioStateHandler(event)

    browserManager.registerGuest({
      browserPageId: 'page-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    onAudioStateChanged({ audible: false })
    browserManager.unregisterGuest('page-1')
    onAudioStateChanged({ audible: true })

    expect(
      rendererSend.mock.calls.filter(([channel]) => channel === 'browser:audio-state-changed')
    ).toEqual([
      ['browser:audio-state-changed', { browserPageId: 'page-1', audible: true }],
      ['browser:audio-state-changed', { browserPageId: 'page-1', audible: false }],
      ['browser:audio-state-changed', { browserPageId: 'page-1', audible: false }]
    ])
  })
})
