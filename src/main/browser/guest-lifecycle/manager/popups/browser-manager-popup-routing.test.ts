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

vi.mock('../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from '../browser-manager'
import { withAgentInputInjection } from '../../../cdp/input/agent-input-injection'
import { runWithActiveRpcCaller } from '../../../../runtime/rpc/callers/active-call'
import {
  registerBrowserRouteGuestPopup,
  releaseBrowserRouteGuestPopup
} from '../../../routing/guest-authority/browser-route-guest-popup-ownership'
import {
  guestNavigationMethods,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from '../browser-manager-test-harness'

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

  // #36804: headless serve pages have no renderer to own Orca's tab model.
  // orcad's Electron browser registers pages without a workspace, so there is no tab list to open into.

  function attachGuest(): {
    guest: { id: number }
    rendererSendMock: ReturnType<typeof vi.fn>
    openLink: (url: string) => void
    pressMouse: () => void
  } {
    const rendererSendMock = vi.fn()
    const guest = {
      ...guestNavigationMethods(),
      id: 145,
      isDestroyed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      setIgnoreMenuShortcuts: vi.fn(),
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
        return { id, isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })
    browserManager.attachGuestPolicies(guest as never)
    const handler: (details: {
      url: string
      frameName: string
      features: string
      disposition: string
    }) => unknown = guestSetWindowOpenHandlerMock.mock.calls[0][0]
    const inputEventHandler = guestOnMock.mock.calls.find(([event]) => event === 'input-event')?.[1]
    return {
      guest,
      rendererSendMock,
      openLink: (url) => {
        handler({ url, frameName: '', features: '', disposition: 'foreground-tab' })
      },
      pressMouse: () => inputEventHandler({}, { type: 'mouseUp' })
    }
  }

  function registerAsTab(guest: { id: number }): void {
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })
  }

  function openedTabs(rendererSendMock: ReturnType<typeof vi.fn>): unknown[] {
    return rendererSendMock.mock.calls.filter(
      ([channel]) => channel === 'browser:open-link-in-orca-tab'
    )
  }

  it("opens an agent's link behind the user's tab, and the user's own click in front", async () => {
    const { guest, rendererSendMock, openLink, pressMouse } = attachGuest()
    registerAsTab(guest)
    const command = runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
      browserManager.beginAgentCommand('browser-1')
    )

    await withAgentInputInjection(guest as never, async () => {
      pressMouse()
    })
    openLink('https://docs.example.com/agent')
    pressMouse()
    openLink('https://docs.example.com/user')
    command.end()

    expect(openedTabs(rendererSendMock)).toEqual([
      [
        'browser:open-link-in-orca-tab',
        { browserPageId: 'browser-1', url: 'https://docs.example.com/agent', activate: false }
      ],
      [
        'browser:open-link-in-orca-tab',
        { browserPageId: 'browser-1', url: 'https://docs.example.com/user' }
      ]
    ])
  })

  it('keeps a tab the page opens long after the agent left behind the user, until the user uses the page', async () => {
    vi.useFakeTimers()
    const { guest, rendererSendMock, openLink, pressMouse } = attachGuest()
    registerAsTab(guest)
    runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
      browserManager.beginAgentCommand('browser-1')
    ).end()

    vi.advanceTimersByTime(60_000)
    openLink('https://login.example.com/late')
    pressMouse()
    vi.advanceTimersByTime(5_000)
    openLink('https://login.example.com/after-user')

    expect(openedTabs(rendererSendMock)).toEqual([
      [
        'browser:open-link-in-orca-tab',
        { browserPageId: 'browser-1', url: 'https://login.example.com/late', activate: false }
      ],
      [
        'browser:open-link-in-orca-tab',
        { browserPageId: 'browser-1', url: 'https://login.example.com/after-user' }
      ]
    ])
  })

  it("keeps a late tab from a popup the agent's page opened behind the user", () => {
    vi.useFakeTimers()
    const { guest, rendererSendMock } = attachGuest()
    registerAsTab(guest)
    runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
      browserManager.beginAgentCommand('browser-1')
    ).end()
    const popup = { ...guest, id: 146 }
    const onDidCreateWindow = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-create-window'
    )?.[1]
    onDidCreateWindow({ webContents: popup })
    const popupHandler = guestSetWindowOpenHandlerMock.mock.calls[1][0]

    vi.advanceTimersByTime(60_000)
    popupHandler({
      url: 'https://login.example.com/from-popup',
      frameName: '',
      features: '',
      disposition: 'foreground-tab'
    })

    expect(openedTabs(rendererSendMock)).toEqual([
      [
        'browser:open-link-in-orca-tab',
        { browserPageId: 'browser-1', url: 'https://login.example.com/from-popup', activate: false }
      ]
    ])
  })

  it("keeps a late tab from an SSH route popup of the agent's page behind the user", () => {
    vi.useFakeTimers()
    const { guest, rendererSendMock } = attachGuest()
    registerAsTab(guest)
    runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
      browserManager.beginAgentCommand('browser-1')
    ).end()
    const routePopup = { ...guest, id: 147 }
    registerBrowserRouteGuestPopup({ popupWebContentsId: 147, openerWebContentsId: guest.id })

    vi.advanceTimersByTime(60_000)
    browserManager.openNewTabPopup(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: openNewTabPopup reads only the guest fields this fake copies from the tab guest.
      routePopup as never,
      { url: 'https://login.example.com/from-route', frameName: '', disposition: 'foreground-tab' },
      null
    )
    releaseBrowserRouteGuestPopup(147)

    expect(openedTabs(rendererSendMock)).toEqual([
      [
        'browser:open-link-in-orca-tab',
        { browserPageId: 'browser-1', url: 'https://login.example.com/from-route', activate: false }
      ]
    ])
  })

  it("opens the system browser for a page with no tab only on the desktop user's own click", async () => {
    const { guest, openLink, pressMouse } = attachGuest()

    await withAgentInputInjection(guest as never, async () => {
      pressMouse()
    })
    openLink('https://docs.example.com/agent')
    openLink('https://docs.example.com/scripted')
    expect(browserMocks.shellOpenExternalMock).not.toHaveBeenCalled()

    pressMouse()
    openLink('https://docs.example.com/user')
    expect(browserMocks.shellOpenExternalMock.mock.calls).toEqual([
      ['https://docs.example.com/user']
    ])
  })
})
