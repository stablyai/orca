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

vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from './browser-manager'
import { BROWSER_AUTOMATION_ACTIVITY_CHANNEL } from '../../shared/browser-automation-activity'
import {
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'

const {
  guestOffMock,
  guestOnMock,
  guestSetBackgroundThrottlingMock,
  guestSetWindowOpenHandlerMock,
  guestOpenDevToolsMock,
  webContentsFromIdMock
} = browserMocks

describe('browserManager', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds capture paint one-way and keeps the renderer unthrottled until the last release', () => {
    vi.useFakeTimers()
    const guest = {
      id: 1707,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const renderer = {
      id: rendererWebContentsId,
      isDestroyed: vi.fn(() => false),
      executeJavaScript: vi.fn(() => new Promise(() => {})),
      send: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      capturePage: vi.fn(async () => null)
    }
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return renderer
      }
      return null
    })
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'page-capture',
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    // Synchronous: a capture never waits on the desktop renderer.
    const releaseFirst = browserManager.holdPaintForCapture(guest.id)
    const releaseSecond = browserManager.holdPaintForCapture(guest.id)

    expect(renderer.executeJavaScript).not.toHaveBeenCalled()
    expect(renderer.send.mock.calls).toEqual([
      ['browser:capturePaintHold', { browserPageId: 'page-capture', held: true }]
    ])
    expect(renderer.setBackgroundThrottling.mock.calls).toEqual([[false]])

    releaseFirst()
    releaseFirst()
    expect(renderer.send).toHaveBeenCalledTimes(1)
    expect(renderer.setBackgroundThrottling.mock.calls).toEqual([[false]])

    releaseSecond()
    expect(renderer.send.mock.calls.at(-1)).toEqual([
      'browser:capturePaintHold',
      { browserPageId: 'page-capture', held: false }
    ])
    expect(renderer.setBackgroundThrottling.mock.calls).toEqual([[false]])
    vi.runAllTimers()
    expect(renderer.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
  })

  it('returns a no-op capture hold for a guest no page owns', () => {
    const release = browserManager.holdPaintForCapture(424242)
    expect(() => release()).not.toThrow()
  })

  it('sends automation activity to the owning renderer without changing guest visibility', () => {
    vi.useFakeTimers()
    const guest = {
      id: 1708,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      once: vi.fn(),
      removeListener: vi.fn(),
      openDevTools: guestOpenDevToolsMock
    }
    const renderer = {
      id: rendererWebContentsId,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      setBackgroundThrottling: vi.fn()
    }
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      return id === renderer.id ? renderer : null
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The guest double supplies the policy and visibility members exercised here.
    browserManager.attachGuestPolicies(guest as never)
    expect(
      browserManager.registerGuest({
        browserPageId: 'page-automation',
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        webContentsId: guest.id,
        rendererWebContentsId
      })
    ).toBe(true)
    guest.setBackgroundThrottling.mockClear()

    const release = browserManager.holdAutomationActivity(guest.id)
    expect(renderer.send).toHaveBeenLastCalledWith(
      BROWSER_AUTOMATION_ACTIVITY_CHANNEL,
      expect.objectContaining({ browserPageId: 'page-automation', active: true })
    )
    release()
    expect(renderer.send).toHaveBeenLastCalledWith(
      BROWSER_AUTOMATION_ACTIVITY_CHANNEL,
      expect.objectContaining({ browserPageId: 'page-automation', active: false })
    )
    expect(guest.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(renderer.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores automation activity for guests without an owning renderer', () => {
    expect(() => browserManager.holdAutomationActivity(424242)()).not.toThrow()
  })
})
