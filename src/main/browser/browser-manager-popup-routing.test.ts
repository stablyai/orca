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
import { MAX_PAGE_INITIATED_TABS_PER_WINDOW } from './browser-page-initiated-tab-budget'
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
  shellOpenExternalMock,
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

  it('validates popup URLs before opening externally', () => {
    const guest = {
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)

    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0] as (details: {
      url: string
    }) => { action: 'deny' }

    expect(handler({ url: 'localhost:3000' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })

    expect(shellOpenExternalMock).toHaveBeenCalledTimes(1)
    expect(shellOpenExternalMock).toHaveBeenCalledWith('http://localhost:3000/')
  })

  it('allows registered safe popup URLs as Electron child windows', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 103,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
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
      features?: string
    }) => {
      action: 'allow' | 'deny'
      overrideBrowserWindowOptions?: unknown
      createWindow?: unknown
    }
    expect(handler({ url: 'about:blank' })).toMatchObject({ action: 'allow' })
    const response = handler({
      url: 'https://example.com/login',
      features: 'alwaysOnTop=yes,frame=no,fullscreen=yes,kiosk=yes,modal=yes,transparent=yes'
    })
    expect(response.action).toBe('allow')
    expect(response.overrideBrowserWindowOptions).toEqual({
      alwaysOnTop: false,
      closable: true,
      focusable: true,
      frame: true,
      fullscreen: false,
      kiosk: false,
      modal: false,
      movable: true,
      opacity: 1,
      show: true,
      simpleFullscreen: false,
      skipTaskbar: false,
      titleBarStyle: 'default',
      transparent: false,
      webPreferences: {
        allowRunningInsecureContent: false,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webviewTag: false
      }
    })
    // Why: the custom createWindow is what swaps the chrome-less native child
    // for Orca's origin-bar window without losing the popup contents.
    expect(typeof response.createWindow).toBe('function')

    expect(shellOpenExternalMock).not.toHaveBeenCalled()
    expect(rendererSendMock).not.toHaveBeenCalled()
  })

  it('keeps opener-dependent window.open popups in-app for every disposition', () => {
    // Regression guard for the reverted #8332: gating the allow on
    // disposition === 'new-window' silently broke featureless window.open()
    // OAuth flows, whose returned handle must stay live. A named target, a
    // features string, and a blank URL each mark such a flow, so all three keep
    // a real child window no matter which disposition Chromium reports.
    const guest = {
      id: 140,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockReturnValue(guest)

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
    const openerDependentOpens = [
      { url: 'https://sso.example.com/auth', frameName: 'ssoWindow', features: '' },
      { url: 'https://sso.example.com/auth', frameName: '', features: 'width=500,height=600' },
      { url: 'about:blank', frameName: '', features: '' }
    ]
    for (const disposition of ['foreground-tab', 'background-tab', 'new-window']) {
      for (const open of openerDependentOpens) {
        expect(handler({ ...open, disposition })).toMatchObject({ action: 'allow' })
      }
    }
    expect(shellOpenExternalMock).not.toHaveBeenCalled()
  })

  it('routes unnamed featureless window.open safely, including after renderer destruction', () => {
    const rendererSendMock = vi.fn()
    let rendererDestroyed = false
    const guest = {
      id: 142,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => rendererDestroyed), send: rendererSendMock }
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
    for (const disposition of ['foreground-tab', 'background-tab']) {
      expect(
        handler({
          url: 'https://docs.example.com/guide',
          frameName: '',
          features: '',
          disposition
        })
      ).toEqual({ action: 'deny' })
    }

    expect(rendererSendMock).toHaveBeenCalledWith('browser:open-link-in-orca-tab', {
      browserPageId: 'browser-1',
      url: 'https://docs.example.com/guide'
    })
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-1',
      origin: 'https://docs.example.com',
      action: 'opened-in-orca'
    })
    expect(openPopupWithOriginBarMock).not.toHaveBeenCalled()
    expect(shellOpenExternalMock).not.toHaveBeenCalled()
    rendererDestroyed = true
    expect(
      handler({
        url: 'https://docs.example.com/guide',
        frameName: '',
        features: '',
        disposition: 'foreground-tab'
      })
    ).toEqual({ action: 'deny' })
    expect(openPopupWithOriginBarMock).not.toHaveBeenCalled()
    expect(shellOpenExternalMock).not.toHaveBeenCalled()
  })

  it('shares the page-initiated tab budget across the whole opener popup tree', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 150,
      isDestroyed: vi.fn(() => false),
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
      createWindow?: (options: Record<string, never>) => unknown
    }
    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0] as WindowOpenHandler

    // A named child popup keeps a real child window; each one used to start with a fresh budget.
    const openNamedChild = (index: number): WindowOpenHandler => {
      const childSetWindowOpenHandlerMock = vi.fn()
      const child = {
        id: 1500 + index,
        isDestroyed: vi.fn(() => false),
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
      result.createWindow?.({})
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

  it('keeps plain links current and routes explicit new-tab gestures to Orca tabs', async () => {
    const rendererSendMock = vi.fn()
    const executeJavaScriptInIsolatedWorldMock = vi.fn().mockResolvedValue(undefined)
    const guest = {
      id: 141,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      executeJavaScriptInIsolatedWorld: executeJavaScriptInIsolatedWorldMock
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

    const domReadyHandler = guestOnMock.mock.calls.find(([event]) => event === 'dom-ready')?.[1] as
      | (() => void)
      | undefined
    domReadyHandler?.()
    await vi.waitFor(() => expect(executeJavaScriptInIsolatedWorldMock).toHaveBeenCalledTimes(1))

    const managerState = browserManager as unknown as {
      clickedLinkFrameNameByGuestId: Map<number, string>
    }
    const clickedLinkFrameName = managerState.clickedLinkFrameNameByGuestId.get(guest.id)
    if (!clickedLinkFrameName) {
      throw new Error('Expected a private clicked-link frame name')
    }
    expect(clickedLinkFrameName).toMatch(/^__orca_clicked_link_foreground_/)
    expect(executeJavaScriptInIsolatedWorldMock).toHaveBeenCalledWith(
      expect.any(Number),
      [
        expect.objectContaining({
          code: expect.stringContaining(
            `${JSON.stringify(clickedLinkFrameName)},${process.platform === 'darwin'})`
          )
        })
      ],
      false
    )

    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0] as (details: {
      url: string
      frameName: string
    }) => { action: 'allow' | 'deny' }
    expect(
      handler({
        url: 'https://docs.example.com/guide',
        frameName: clickedLinkFrameName
      })
    ).toEqual({ action: 'deny' })

    expect(rendererSendMock).toHaveBeenCalledWith('browser:open-link-in-orca-tab', {
      browserPageId: 'browser-1',
      url: 'https://docs.example.com/guide'
    })
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-1',
      origin: 'https://docs.example.com',
      action: 'opened-in-orca'
    })
    expect(openPopupWithOriginBarMock).not.toHaveBeenCalled()
    expect(shellOpenExternalMock).not.toHaveBeenCalled()
  })

  it('routes child-frame gestures with one-use tokens', async () => {
    const rendererSendMock = vi.fn()
    const executeJavaScriptMock = vi.fn().mockResolvedValue(undefined)
    const frameOnceMock = vi.fn()
    const frame = {
      parent: {},
      isDestroyed: vi.fn(() => false),
      executeJavaScript: executeJavaScriptMock,
      once: frameOnceMock,
      off: vi.fn()
    }
    const guest = {
      id: 142,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue(undefined)
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
      browserPageId: 'browser-frame',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    const frameCreatedHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'frame-created'
    )?.[1] as ((event: Electron.Event, details: Electron.FrameCreatedDetails) => void) | undefined
    frameCreatedHandler?.({} as Electron.Event, { frame } as never)
    const frameDomReadyHandler = frameOnceMock.mock.calls.find(
      ([event]) => event === 'dom-ready'
    )?.[1] as (() => void) | undefined
    frameDomReadyHandler?.()

    await vi.waitFor(() => expect(executeJavaScriptMock).toHaveBeenCalledTimes(1))
    const firstScript = executeJavaScriptMock.mock.calls[0][0] as string
    const foregroundFrameName = firstScript.match(
      /__orca_clicked_link_iframe_foreground_[0-9a-f-]+/
    )?.[0]
    if (!foregroundFrameName) {
      throw new Error('Expected a private child-frame routing token')
    }
    expect(firstScript).toContain('installBrowserIframeClickedLinkRouting')
    expect(executeJavaScriptMock).toHaveBeenCalledWith(firstScript, false)

    const popupHandler = guestSetWindowOpenHandlerMock.mock.calls[0][0] as (details: {
      url: string
      frameName: string
    }) => { action: string }
    expect(
      popupHandler({
        url: 'https://docs.example.com/from-frame',
        frameName: foregroundFrameName
      })
    ).toEqual({ action: 'deny' })
    expect(rendererSendMock).toHaveBeenCalledWith('browser:open-link-in-orca-tab', {
      browserPageId: 'browser-frame',
      url: 'https://docs.example.com/from-frame'
    })

    await vi.waitFor(() => expect(executeJavaScriptMock).toHaveBeenCalledTimes(2))
    const secondScript = executeJavaScriptMock.mock.calls[1][0] as string
    expect(secondScript).not.toContain(foregroundFrameName)
  })

  it('hosts allowed popups in an origin-bar window with inherited guest policies', () => {
    const rendererSendMock = vi.fn()
    const guestOnceMock = vi.fn()
    const guest = {
      id: 150,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      once: guestOnceMock,
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

    const popupContents = {
      id: 151,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'window'),
      setBackgroundThrottling: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn()
    }
    const popupCloseMock = vi.fn()
    const popupOnClosedMock = vi.fn()
    openPopupWithOriginBarMock.mockReturnValue({
      contentWebContents: popupContents,
      close: popupCloseMock,
      onClosed: popupOnClosedMock
    })

    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0] as (details: {
      url: string
    }) => {
      action: string
      createWindow: (options: Record<string, unknown>) => unknown
    }
    const response = handler({ url: 'https://sso.example.com/auth?code=SECRET' })
    const preCreatedContents = { id: 152 }
    const options = { webContents: preCreatedContents, width: 500, height: 600 }
    const returned = response.createWindow(options)

    expect(openPopupWithOriginBarMock).toHaveBeenCalledWith(
      options,
      'https://sso.example.com/auth?code=SECRET'
    )
    expect(returned).toBe(popupContents)
    // did-create-window does not fire for createWindow-created children, so
    // the popup must get guest policies (nav guards, recursive popup handling)
    // attached directly here.
    expect(popupContents.setWindowOpenHandler).toHaveBeenCalledTimes(1)
    expect(popupContents.setBackgroundThrottling).toHaveBeenCalledWith(false)
    expect(popupContents.on.mock.calls.some(([event]) => event === 'dom-ready')).toBe(false)
    // The renderer notice carries only the sanitized origin, never the URL.
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-1',
      origin: 'https://sso.example.com',
      action: 'opened-in-orca'
    })

    // Opener-lifecycle parity: destroying the owning guest closes the popup.
    const destroyedCall = guestOnceMock.mock.calls.find(([event]) => event === 'destroyed')
    expect(destroyedCall).toBeDefined()
    ;(destroyedCall as [string, () => void])[1]()
    expect(popupCloseMock).toHaveBeenCalledTimes(1)

    // Popup windows opened by the popup itself keep the owner context, so the
    // recursive handler still routes to the owning browser tab.
    const popupHandler = popupContents.setWindowOpenHandler.mock.calls[0][0] as (details: {
      url: string
    }) => { action: string }
    openPopupWithOriginBarMock.mockReturnValue({
      contentWebContents: { ...popupContents, id: 153 },
      close: vi.fn(),
      onClosed: vi.fn()
    })
    expect(popupHandler({ url: 'https://sso.example.com/step2' })).toMatchObject({
      action: 'allow'
    })
  })

  it('blocks unsafe popup URLs for registered guests', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 106,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
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
    }) => { action: 'allow' | 'deny' }
    expect(handler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'file:///C:/Users/example/.ssh/id_rsa' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'file://server/share/private.txt' })).toEqual({ action: 'deny' })

    expect(shellOpenExternalMock).not.toHaveBeenCalled()
    expect(rendererSendMock).not.toHaveBeenCalledWith(
      'browser:open-link-in-orca-tab',
      expect.anything()
    )
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-1',
      origin: 'null',
      action: 'blocked'
    })
  })

  it('falls back to opening popup URLs externally before a guest is registered', () => {
    const guest = {
      id: 105,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)

    const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0] as (details: {
      url: string
    }) => { action: 'deny' }
    expect(handler({ url: 'https://example.com/login' })).toEqual({ action: 'deny' })

    expect(shellOpenExternalMock).toHaveBeenCalledWith('https://example.com/login')
  })

  it('offers opening a link in another Orca browser tab from the guest context menu', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 104,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://example.com'),
      navigationHistory: {
        canGoBack: vi.fn(() => false),
        canGoForward: vi.fn(() => false)
      },
      reload: vi.fn()
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

    const contextMenuHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'context-menu'
    )?.[1] as ((event: unknown, params: Electron.ContextMenuParams) => void) | undefined

    contextMenuHandler?.({}, { linkURL: 'https://example.com/docs' } as Electron.ContextMenuParams)

    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:context-menu-requested',
      expect.objectContaining({
        browserPageId: 'browser-1',
        pageUrl: 'https://example.com',
        linkUrl: 'https://example.com/docs',
        canGoBack: false,
        canGoForward: false
      })
    )
  })
})
