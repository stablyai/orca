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
    prependListener: vi.fn(),
    off: vi.fn(),
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
  MAX_PAGE_INITIATED_TABS_PER_WINDOW,
  PAGE_INITIATED_TAB_WINDOW_MS
} from '../popups/browser-page-initiated-tab-budget'
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
  webContentsFromIdMock,
  openPopupWithOriginBarMock
} = browserMocks

describe('browserManager', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // #36804: headless serve pages have no renderer to own Orca's tab model.
  // orcad's Electron browser registers pages without a workspace, so there is no tab list to open into.

  it('opens a tab for every clicked link but caps scripted opens', () => {
    vi.useFakeTimers()
    const rendererSendMock = vi.fn()
    const guest = {
      id: 144,
      isDestroyed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      prependListener: vi.fn(),
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0] as (details: {
      url: string
      frameName: string
      features: string
      disposition: string
    }) => { action: 'allow' | 'deny' }
    const inputEventHandler = guestOnMock.mock.calls.find(([event]) => event === 'input-event')?.[1]
    const open = (index: number): void => {
      handler({
        url: `https://docs.example.com/${index}`,
        frameName: '',
        features: '',
        disposition: 'background-tab'
      })
    }
    const routedTabCount = (): number =>
      rendererSendMock.mock.calls.filter(([channel]) => channel === 'browser:open-link-in-orca-tab')
        .length

    const clicks = MAX_PAGE_INITIATED_TABS_PER_WINDOW * 2
    for (let index = 0; index < clicks; index++) {
      inputEventHandler({}, { type: 'mouseUp' })
      open(index)
    }
    expect(routedTabCount()).toBe(clicks)

    // Each observed input bypasses the budget once.
    inputEventHandler({}, { type: 'mouseUp' })
    for (let index = 0; index < MAX_PAGE_INITIATED_TABS_PER_WINDOW * 2; index++) {
      open(clicks + index)
    }
    expect(routedTabCount()).toBe(clicks + 1 + MAX_PAGE_INITIATED_TABS_PER_WINDOW)

    // Spending activation on a popup cannot fund a later tab.
    vi.advanceTimersByTime(PAGE_INITIATED_TAB_WINDOW_MS)
    inputEventHandler({}, { type: 'mouseUp' })
    expect(
      handler({
        url: 'https://sso.example.com/auth',
        frameName: 'sso',
        features: 'width=500,height=600',
        disposition: 'new-window'
      })
    ).toMatchObject({ action: 'allow' })
    const tabsBeforeScriptedLoop = routedTabCount()
    for (let index = 0; index < MAX_PAGE_INITIATED_TABS_PER_WINDOW * 2; index++) {
      open(clicks * 2 + index)
    }
    expect(routedTabCount()).toBe(tabsBeforeScriptedLoop + MAX_PAGE_INITIATED_TABS_PER_WINDOW)
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-1',
      origin: 'https://docs.example.com',
      action: 'blocked'
    })
  })

  it('shares the page-initiated tab budget across the whole opener popup tree', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 150,
      isDestroyed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      once: vi.fn(),
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const guestsById = new Map<number, unknown>([[guest.id, guest]])
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return guestsById.get(id) ?? null
    })

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    type WindowOpenHandler = (details: {
      url: string
      frameName: string
      features: string
      disposition: string
    }) => {
      action: 'allow' | 'deny'
      createWindow?: (options: Record<string, unknown>) => unknown
    }
    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0] as WindowOpenHandler

    // Named child popups must share the root opener budget.
    const openNamedChild = (index: number): WindowOpenHandler => {
      const childSetWindowOpenHandlerMock = vi.fn()
      const child = {
        id: 1500 + index,
        isDestroyed: vi.fn(() => false),
        isCurrentlyAudible: vi.fn(() => false),
        getType: vi.fn(() => 'webview'),
        setBackgroundThrottling: vi.fn(),
        setWindowOpenHandler: childSetWindowOpenHandlerMock,
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        openDevTools: vi.fn()
      }
      guestsById.set(child.id, child)
      openPopupWithOriginBarMock.mockReturnValueOnce({
        contentWebContents: child,
        close: vi.fn(),
        onClosed: vi.fn()
      })
      const result = handler({
        url: `https://sso.example.com/child-${index}`,
        frameName: `child-${index}`,
        features: '',
        disposition: 'new-window'
      })
      expect(result).toMatchObject({ action: 'allow' })
      result.createWindow?.({ webContents: child })
      openPopupWithOriginBarMock.mock.calls.at(-1)?.[2](child)
      return childSetWindowOpenHandlerMock.mock.calls[0][0] as WindowOpenHandler
    }

    const childHandlers = [openNamedChild(0), openNamedChild(1), openNamedChild(2)]
    for (const [childIndex, childHandler] of childHandlers.entries()) {
      for (let openIndex = 0; openIndex < MAX_PAGE_INITIATED_TABS_PER_WINDOW; openIndex++) {
        expect(
          childHandler({
            url: `https://docs.example.com/${childIndex}-${openIndex}`,
            frameName: '',
            features: '',
            disposition: 'foreground-tab'
          })
        ).toEqual({ action: 'deny' })
      }
    }

    const routedTabs = rendererSendMock.mock.calls.filter(
      ([channel]) => channel === 'browser:open-link-in-orca-tab'
    )
    expect(routedTabs).toHaveLength(MAX_PAGE_INITIATED_TABS_PER_WINDOW)
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-1',
      origin: 'https://docs.example.com',
      action: 'blocked'
    })
    expect(openPopupWithOriginBarMock).toHaveBeenCalledTimes(childHandlers.length)
  })
})
