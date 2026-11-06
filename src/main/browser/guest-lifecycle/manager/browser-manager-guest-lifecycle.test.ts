import { EventEmitter } from 'node:events'
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
  WebContentsView: class {
    onDestroyed: (() => void) | null = null
    webContents = {
      id: 9001,
      isDestroyed: () => false,
      close: () => this.onDestroyed?.(),
      once: (_event: string, listener: () => void) => {
        this.onDestroyed = listener
      },
      focus: vi.fn()
    }
    setVisible(): void {}
  },
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

vi.mock('../popups/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from '../../browser-manager'
import {
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'
import { revokeAllDocPreviewGrants } from '../../document-preview/doc-preview-grant-registry'

const {
  guestSetBackgroundThrottlingMock,
  guestSetWindowOpenHandlerMock,
  guestOpenDevToolsMock,
  webContentsFromIdMock
} = browserMocks

describe('browserManager', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
    revokeAllDocPreviewGrants()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // The headless backend destroys its window when registration returns false.

  it("publishes an offscreen page's top-level address changes, not its subframes'", () => {
    const stateChanged = vi.fn()
    browserManager.setBrowserGuestStateChangedListener(stateChanged)
    let address = 'https://example.com/'
    const guest = Object.assign(new EventEmitter(), {
      id: 515,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'window'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      isCurrentlyAudible: vi.fn(() => false),
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      getURL: vi.fn(() => address)
    })
    webContentsFromIdMock.mockReturnValue(guest)
    browserManager.registerOffscreenGuest({
      browserPageId: 'offscreen-page',
      worktreeId: 'remote-worktree',
      webContentsId: guest.id
    })
    const navigateInPage = (url: string): void => {
      address = url
      guest.emit('did-navigate-in-page', {}, url, true, 1, 1)
    }

    guest.emit('did-navigate-in-page', {}, 'https://frame.example/#x', false, 1, 2)
    expect(stateChanged).not.toHaveBeenCalled()

    navigateInPage('https://example.com/#top')
    expect(stateChanged).toHaveBeenCalledTimes(1)
    expect(stateChanged).toHaveBeenLastCalledWith('remote-worktree')

    // replaceState without a new address.
    navigateInPage('https://example.com/#top')
    expect(stateChanged).toHaveBeenCalledTimes(1)

    address = 'https://example.com/next'
    guest.emit('did-navigate', {}, address, 200, 'OK')
    expect(stateChanged).toHaveBeenCalledTimes(2)

    // A full navigation also counts as the address to compare with.
    navigateInPage('https://example.com/next')
    expect(stateChanged).toHaveBeenCalledTimes(2)

    browserManager.unregisterGuest('offscreen-page')
    expect(guest.listenerCount('did-navigate-in-page')).toBe(0)
  })

  it('retires stale guest mappings when a page re-registers after a process swap', () => {
    const rendererSendMock = vi.fn()
    const oldGuestOnMock = vi.fn()
    const oldGuestOffMock = vi.fn()
    const newGuestOnMock = vi.fn()
    const newGuestOffMock = vi.fn()
    const oldGuest = {
      id: 501,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: oldGuestOnMock,
      off: oldGuestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://old.example')
    }
    const newGuest = {
      id: 502,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: newGuestOnMock,
      off: newGuestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://new.example')
    }

    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === oldGuest.id) {
        return oldGuest
      }
      if (id === newGuest.id) {
        return newGuest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })

    browserManager.attachGuestPolicies(oldGuest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: oldGuest.id,
      rendererWebContentsId
    })

    browserManager.attachGuestPolicies(newGuest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: newGuest.id,
      rendererWebContentsId
    })
    // Registration also reports audio state; this test is about load-failure routing.
    rendererSendMock.mockClear()

    const oldDidFailLoadHandler = oldGuestOnMock.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as
      | ((
          event: unknown,
          errorCode: number,
          errorDescription: string,
          validatedUrl: string,
          isMainFrame: boolean
        ) => void)
      | undefined
    const newDidFailLoadHandler = newGuestOnMock.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as
      | ((
          event: unknown,
          errorCode: number,
          errorDescription: string,
          validatedUrl: string,
          isMainFrame: boolean
        ) => void)
      | undefined

    oldDidFailLoadHandler?.(null, -105, 'Old guest failed', 'https://old.example', true)
    expect(rendererSendMock).not.toHaveBeenCalled()

    newDidFailLoadHandler?.(null, -106, 'New guest failed', 'https://new.example', true)
    expect(rendererSendMock).toHaveBeenCalledWith('browser:guest-load-failed', {
      browserPageId: 'browser-1',
      loadError: {
        code: -106,
        description: 'New guest failed',
        validatedUrl: 'https://new.example'
      }
    })
    expect(oldGuestOffMock).toHaveBeenCalled()
    expect(browserManager.getGuestWebContentsId('browser-1')).toBe(newGuest.id)
    expect(browserManager.getTabIdForWebContentsId(oldGuest.id)).toBeNull()
    expect(browserManager.getTabIdForWebContentsId(newGuest.id)).toBe('browser-1')

    browserManager.unregisterGuest('browser-1')
    expect(browserManager.getTabIdForWebContentsId(newGuest.id)).toBeNull()
  })

  // Browsing guests track override invalidation without attaching a debugger.

  // The renderer re-applies a tab's mute on each registration report and clears the
  // speaker on the unregister report, so neither may be skipped.
})
