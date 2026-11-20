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
import { MAX_PAGE_INITIATED_TABS_PER_WINDOW } from '../../popups/browser-page-initiated-tab-budget'
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

  function provisionalChild(opener: object | null) {
    return {
      opener,
      isDestroyed: () => false,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      close: vi.fn()
    }
  }

  function finishOpenedWindow(response: unknown, opener: object | null): void {
    if (
      typeof response !== 'object' ||
      response === null ||
      !('action' in response) ||
      response.action !== 'allow' ||
      !('createWindow' in response) ||
      typeof response.createWindow !== 'function'
    ) {
      return
    }
    response.createWindow({ webContents: provisionalChild(opener) })
  }

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
      isCrashed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      setIgnoreMenuShortcuts: vi.fn(),
      on: guestOnMock,
      once: vi.fn(),
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
    const mouseEventHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'before-mouse-event'
    )?.[1]
    return {
      guest,
      rendererSendMock,
      openLink: (url) => {
        // A target=_blank link has no opener. Electron only reveals that after allow.
        finishOpenedWindow(
          handler({ url, frameName: '', features: '', disposition: 'foreground-tab' }),
          null
        )
      },
      pressMouse: () => mouseEventHandler({}, { type: 'mouseUp' })
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
    finishOpenedWindow(
      popupHandler({
        url: 'https://login.example.com/from-popup',
        frameName: '',
        features: '',
        disposition: 'foreground-tab'
      }),
      null
    )

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

  it("tells the agent's page it leads it, so its print is refused and reported, until the user uses the page", () => {
    const { guest, pressMouse } = attachGuest()
    registerAsTab(guest)
    const leads: [number, boolean][] = []
    browserManager.setAgentLeadListener((guestId, led) => leads.push([guestId, led]))
    const events: unknown[] = []
    browserManager.observePageEvents('browser-1', (event) => events.push(event))
    runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
      browserManager.beginAgentCommand('browser-1')
    ).end()
    runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
      browserManager.beginAgentCommand('browser-1')
    ).end()

    browserManager.reportRefusedPrint(guest.id, 'https://shop.example.com')
    pressMouse()
    browserManager.reportRefusedPrint(guest.id, 'https://shop.example.com')

    expect(leads).toEqual([
      [guest.id, true],
      [guest.id, false]
    ])
    expect(events).toEqual([{ kind: 'print', origin: 'https://shop.example.com' }])
  })

  it('reports a refused print to an agent command on the popup page that asked', () => {
    const { guest } = attachGuest()
    registerAsTab(guest)
    const onDidCreateWindow = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-create-window'
    )?.[1]
    onDidCreateWindow({ webContents: { ...guest, id: 146 } })
    const events: unknown[] = []
    browserManager.observePageEvents('popup-146', (event) => events.push(event))
    runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
      browserManager.beginAgentCommand('popup-146')
    ).end()

    browserManager.reportRefusedPrint(146, 'https://pay.example.com')
    expect(events).toEqual([{ kind: 'print', origin: 'https://pay.example.com' }])
  })

  it('leads an SSH route popup the agent drives directly through its opener', () => {
    const { guest } = attachGuest()
    registerAsTab(guest)
    registerBrowserRouteGuestPopup({ popupWebContentsId: 147, openerWebContentsId: guest.id })
    runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
      browserManager.beginAgentCommand('popup-147')
    ).end()

    const led = browserManager.isAgentLedGuest(147)
    releaseBrowserRouteGuestPopup(147)
    expect(led).toBe(true)
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

  function openDetails(
    features: string,
    disposition: 'foreground-tab' | 'background-tab' | 'new-window'
  ) {
    return {
      url: 'https://docs.example.com/opened',
      frameName: '',
      features,
      disposition,
      referrer: { url: 'https://example.com/', policy: 'strict-origin-when-cross-origin' as const }
    }
  }

  it('keeps window.opener for window.open(url, "_blank") with no features', () => {
    browserMocks.openPopupWithOriginBarMock.mockImplementation(
      (options: { webContents: { close: () => void } }) => ({
        contentWebContents: options.webContents,
        close: vi.fn(),
        onClosed: vi.fn()
      })
    )
    const { guest, rendererSendMock, pressMouse } = attachGuest()
    registerAsTab(guest)
    pressMouse()
    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0]
    const child = provisionalChild({ frameTreeNodeId: 7 })

    const response = handler(openDetails('', 'foreground-tab'))
    const adopted = response.createWindow?.({ webContents: child })

    expect(response.action).toBe('allow')
    expect(adopted).toBe(child)
    expect(child.close).not.toHaveBeenCalled()
    expect(openedTabs(rendererSendMock)).toEqual([])
  })

  it('denies an ungestured window.open and stops it once the page-initiated tab budget is spent', () => {
    const { guest, rendererSendMock } = attachGuest()
    registerAsTab(guest)
    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0]
    const events: unknown[] = []
    browserManager.observePageEvents('browser-1', (event) => events.push(event))

    for (let opened = 0; opened < MAX_PAGE_INITIATED_TABS_PER_WINDOW; opened += 1) {
      expect(handler(openDetails('', 'foreground-tab'))).toEqual({ action: 'deny' })
    }
    expect(openedTabs(rendererSendMock)).toHaveLength(MAX_PAGE_INITIATED_TABS_PER_WINDOW)

    expect(handler(openDetails('', 'foreground-tab'))).toEqual({ action: 'deny' })

    expect(openedTabs(rendererSendMock)).toHaveLength(MAX_PAGE_INITIATED_TABS_PER_WINDOW)
    expect(events).toContainEqual({
      kind: 'popup',
      action: 'blocked',
      origin: 'https://docs.example.com'
    })
    expect(browserMocks.openPopupWithOriginBarMock).not.toHaveBeenCalled()
  })

  it('downloads a claimed agent file opened with window.open instead of creating a popup', () => {
    const { guest, rendererSendMock, pressMouse } = attachGuest()
    const downloadURL = vi.fn()
    Object.assign(guest, { downloadURL })
    registerAsTab(guest)
    pressMouse()
    const claim = browserManager.claimNextDownload(guest.id, '/tmp/claimed.bin')
    try {
      const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0]
      const response = handler(openDetails('', 'foreground-tab'))

      expect(response).toEqual({ action: 'deny' })
      expect(downloadURL).toHaveBeenCalledTimes(1)
      expect(downloadURL).toHaveBeenCalledWith('https://docs.example.com/opened')
      expect(openedTabs(rendererSendMock)).toEqual([])
      expect(browserMocks.openPopupWithOriginBarMock).not.toHaveBeenCalled()
    } finally {
      claim.release()
    }
  })

  it('opens window.open(url, "_blank", "noopener") as a tab without an opener', () => {
    const { guest, rendererSendMock, pressMouse } = attachGuest()
    registerAsTab(guest)
    pressMouse()
    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0]

    const response = handler(openDetails('noopener', 'foreground-tab'))

    expect(response).toEqual({ action: 'deny' })
    expect(openedTabs(rendererSendMock)).toEqual([
      [
        'browser:open-link-in-orca-tab',
        { browserPageId: 'browser-1', url: 'https://docs.example.com/opened' }
      ]
    ])
  })

  it('opens window.open(url, "_blank", "noreferrer") as a tab without an opener', () => {
    const { guest, rendererSendMock, pressMouse } = attachGuest()
    registerAsTab(guest)
    pressMouse()
    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0]

    const response = handler(openDetails('noreferrer', 'foreground-tab'))

    expect(response).toEqual({ action: 'deny' })
    expect(openedTabs(rendererSendMock)).toEqual([
      [
        'browser:open-link-in-orca-tab',
        { browserPageId: 'browser-1', url: 'https://docs.example.com/opened' }
      ]
    ])
  })

  it('opens a target="_blank" link as a tab because its child has no opener', () => {
    const { guest, rendererSendMock, pressMouse } = attachGuest()
    registerAsTab(guest)
    pressMouse()
    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0]
    const child = provisionalChild(null)

    const response = handler(openDetails('', 'foreground-tab'))
    if (response.action === 'allow') {
      response.createWindow?.({ webContents: child })
    }

    expect(openedTabs(rendererSendMock)).toEqual([
      [
        'browser:open-link-in-orca-tab',
        { browserPageId: 'browser-1', url: 'https://docs.example.com/opened' }
      ]
    ])
    expect(child.close).toHaveBeenCalled()
    expect(browserMocks.openPopupWithOriginBarMock).not.toHaveBeenCalled()
  })

  it('keeps window.opener for a target="_blank" link that sets rel="opener"', () => {
    browserMocks.openPopupWithOriginBarMock.mockImplementation(
      (options: { webContents: { close: () => void } }) => ({
        contentWebContents: options.webContents,
        close: vi.fn(),
        onClosed: vi.fn()
      })
    )
    const { guest, rendererSendMock, pressMouse } = attachGuest()
    registerAsTab(guest)
    pressMouse()
    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0]
    const child = provisionalChild({ frameTreeNodeId: 9 })

    const response = handler(openDetails('', 'foreground-tab'))
    const adopted = response.createWindow?.({ webContents: child })

    expect(response.action).toBe('allow')
    expect(adopted).toBe(child)
    expect(openedTabs(rendererSendMock)).toEqual([])
  })

  it('opens a middle-clicked link as a background tab', () => {
    const { guest, rendererSendMock, pressMouse } = attachGuest()
    registerAsTab(guest)
    pressMouse()
    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0]

    const response = handler(openDetails('', 'background-tab'))

    expect(response).toEqual({ action: 'deny' })
    expect(openedTabs(rendererSendMock)).toEqual([
      [
        'browser:open-link-in-orca-tab',
        {
          browserPageId: 'browser-1',
          url: 'https://docs.example.com/opened',
          activate: false
        }
      ]
    ])
  })

  it('keeps a features popup on the opener-preserving child window', () => {
    browserMocks.openPopupWithOriginBarMock.mockImplementation(
      (options: { webContents: { close: () => void } }) => ({
        contentWebContents: options.webContents,
        close: vi.fn(),
        onClosed: vi.fn()
      })
    )
    const { guest, rendererSendMock, pressMouse } = attachGuest()
    registerAsTab(guest)
    pressMouse()
    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0]
    const child = provisionalChild({ frameTreeNodeId: 11 })

    const response = handler(openDetails('popup,width=420,height=600', 'new-window'))
    const adopted = response.createWindow?.({ webContents: child })

    expect(response.action).toBe('allow')
    expect(adopted).toBe(child)
    expect(openedTabs(rendererSendMock)).toEqual([])
  })
})
