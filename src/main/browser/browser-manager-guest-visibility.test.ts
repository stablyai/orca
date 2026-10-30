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
import { rendererPublicationThrottle } from '../window/renderer-publication-throttle'
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

  it('keeps idle guests throttled and holds both contents until the last capture release', () => {
    vi.useFakeTimers()
    const guest = {
      id: 1707,
      isDestroyed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      capturePage: vi.fn(async () => null),
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
    // Registration also reports audio state; this test is about paint holds.
    renderer.send.mockClear()
    expect(guestSetBackgroundThrottlingMock).not.toHaveBeenCalled()

    // Synchronous: a capture never waits on the desktop renderer.
    const releaseFirst = browserManager.holdPaintForCapture(guest.id)
    const releaseSecond = browserManager.holdPaintForCapture(guest.id)

    expect(renderer.executeJavaScript).not.toHaveBeenCalled()
    expect(renderer.send.mock.calls).toEqual([
      ['browser:capturePaintHold', { browserPageId: 'page-capture', held: true }]
    ])
    expect(renderer.setBackgroundThrottling.mock.calls).toEqual([[false]])
    expect(guestSetBackgroundThrottlingMock.mock.calls).toEqual([[false]])

    releaseFirst()
    releaseFirst()
    expect(renderer.send).toHaveBeenCalledTimes(1)
    expect(renderer.setBackgroundThrottling.mock.calls).toEqual([[false]])
    expect(guestSetBackgroundThrottlingMock.mock.calls).toEqual([[false]])

    releaseSecond()
    expect(renderer.send.mock.calls.at(-1)).toEqual([
      'browser:capturePaintHold',
      { browserPageId: 'page-capture', held: false }
    ])
    expect(renderer.setBackgroundThrottling.mock.calls).toEqual([[false]])
    vi.runAllTimers()
    expect(renderer.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
    expect(guestSetBackgroundThrottlingMock.mock.calls).toEqual([[false], [true]])
  })

  it('shares guest leases with a concurrent stream even without a desktop renderer', () => {
    vi.useFakeTimers()
    const guest = {
      id: 1708,
      isDestroyed: vi.fn(() => false),
      setBackgroundThrottling: vi.fn(),
      capturePage: vi.fn(async () => null)
    }
    webContentsFromIdMock.mockReturnValue(guest)
    const releaseStream = rendererPublicationThrottle.acquire(guest)
    const releaseCapture = browserManager.holdPaintForCapture(guest.id)

    releaseStream()
    vi.runAllTimers()
    expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false]])

    releaseCapture()
    releaseCapture()
    vi.runAllTimers()
    expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
  })

  it.each(['notify', 'acquire', 'release'] as const)(
    'cleans capture ownership after renderer %s fails',
    (failure) => {
      vi.useFakeTimers()
      const guest = {
        id: 1711,
        isDestroyed: vi.fn(() => false),
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
      const fail = (): never => {
        throw new Error('renderer unavailable')
      }
      if (failure === 'release') {
        const release = browserManager.holdPaintForCapture(guest.id)
        renderer.send.mockImplementationOnce(fail)
        expect(release).not.toThrow()
      } else if (failure === 'notify') {
        renderer.send.mockImplementationOnce(fail)
        const release = browserManager.holdPaintForCapture(guest.id)
        expect(release).not.toThrow()
      } else {
        renderer.setBackgroundThrottling.mockImplementationOnce(fail)
        expect(() => browserManager.holdPaintForCapture(guest.id)).toThrow('renderer unavailable')
      }
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
    }
  )

  it('does not let a destroyed guest and renderer release a replacement page hold', () => {
    vi.useFakeTimers()
    const makeGuest = (id: number) => ({
      id,
      isDestroyed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: vi.fn(),
      capturePage: vi.fn(async () => null),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      openDevTools: vi.fn()
    })
    const makeRenderer = (id: number) => ({
      id,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      capturePage: vi.fn(async () => null)
    })
    const oldGuest = makeGuest(1709)
    const newGuest = makeGuest(1710)
    const oldRenderer = makeRenderer(rendererWebContentsId)
    const newRenderer = makeRenderer(rendererWebContentsId + 1)
    webContentsFromIdMock.mockImplementation((id: number) =>
      [oldGuest, newGuest, oldRenderer, newRenderer].find((contents) => contents.id === id)
    )
    const register = (guest: ReturnType<typeof makeGuest>, rendererId: number) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this guest provides the policy and registration members exercised here.
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'page-replaced',
        webContentsId: guest.id,
        rendererWebContentsId: rendererId
      })
    }
    register(oldGuest, oldRenderer.id)
    const releaseOld = browserManager.holdPaintForCapture(oldGuest.id)
    oldGuest.isDestroyed.mockReturnValue(true)
    oldRenderer.isDestroyed.mockReturnValue(true)
    register(newGuest, newRenderer.id)
    newRenderer.send.mockClear()
    const releaseNew = browserManager.holdPaintForCapture(newGuest.id)

    releaseOld()
    vi.runAllTimers()
    expect(newRenderer.send.mock.calls).toEqual([
      ['browser:capturePaintHold', { browserPageId: 'page-replaced', held: true }]
    ])
    expect(oldGuest.setBackgroundThrottling.mock.calls).toEqual([[false]])
    expect(oldRenderer.setBackgroundThrottling.mock.calls).toEqual([[false]])
    expect(newGuest.setBackgroundThrottling.mock.calls).toEqual([[false]])
    expect(newRenderer.setBackgroundThrottling.mock.calls).toEqual([[false]])

    releaseNew()
    vi.runAllTimers()
    expect(newRenderer.send.mock.calls.at(-1)).toEqual([
      'browser:capturePaintHold',
      { browserPageId: 'page-replaced', held: false }
    ])
    expect(newGuest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
    expect(newRenderer.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
  })
})
