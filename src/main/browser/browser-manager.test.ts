/* oxlint-disable max-lines */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  openPopupWithOriginBarMock,
  appGetPathMock,
  shellOpenExternalMock,
  browserWindowFromWebContentsMock,
  menuBuildFromTemplateMock,
  guestOffMock,
  guestOnMock,
  guestSetBackgroundThrottlingMock,
  guestSetWindowOpenHandlerMock,
  guestOpenDevToolsMock,
  webContentsFromIdMock,
  screenGetCursorScreenPointMock
} = vi.hoisted(() => ({
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
    getPath: appGetPathMock
  },
  BrowserWindow: {
    fromWebContents: browserWindowFromWebContentsMock
  },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: shellOpenExternalMock },
  Menu: {
    buildFromTemplate: menuBuildFromTemplateMock
  },
  screen: {
    getCursorScreenPoint: screenGetCursorScreenPointMock
  },
  webContents: {
    fromId: webContentsFromIdMock
  }
}))

vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: openPopupWithOriginBarMock
}))

import { browserManager } from './browser-manager'
import { googleAuthUserAgent } from './browser-google-auth-ua'
import { setBrowserSessionUserAgentMode } from './browser-session-user-agent-mode'

describe('browserManager', () => {
  const rendererWebContentsId = 5001
  // Base (non-Firefox) UA a guest reports off the Google auth hosts.
  const guestBaseUserAgent = 'Mozilla/5.0 (Test) Chrome/140.0.0.0'
  const guestUaMethods = () => ({
    getUserAgent: vi.fn(() => guestBaseUserAgent),
    setUserAgent: vi.fn(),
    session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
  })
  type DownloadItemHandlerState = 'progressing' | 'interrupted' | 'completed' | 'cancelled'
  type DownloadItemHandler = (event: Electron.Event, state: DownloadItemHandlerState) => void

  function createDownloadItem(
    overrides: Partial<Electron.DownloadItem> = {}
  ): Electron.DownloadItem {
    return {
      setSavePath: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      cancel: vi.fn(),
      getFilename: vi.fn(() => 'report.csv'),
      getTotalBytes: vi.fn(() => 2048),
      getMimeType: vi.fn(() => 'text/csv'),
      getURL: vi.fn(() => 'https://example.com/report.csv'),
      getReceivedBytes: vi.fn(() => 0),
      ...overrides
    } as unknown as Electron.DownloadItem
  }

  function getDownloadItemEventHandler(
    item: Electron.DownloadItem,
    method: 'on' | 'once',
    eventName: string
  ): DownloadItemHandler | undefined {
    const eventMock = item[method] as unknown as {
      mock: { calls: [string, DownloadItemHandler][] }
    }
    return eventMock.mock.calls.find(([event]) => event === eventName)?.[1]
  }

  beforeEach(() => {
    appGetPathMock.mockReset()
    appGetPathMock.mockReturnValue('/downloads')
    shellOpenExternalMock.mockReset()
    browserWindowFromWebContentsMock.mockReset()
    menuBuildFromTemplateMock.mockReset()
    guestOffMock.mockReset()
    guestOnMock.mockReset()
    guestSetBackgroundThrottlingMock.mockReset()
    guestSetWindowOpenHandlerMock.mockReset()
    guestOpenDevToolsMock.mockReset()
    webContentsFromIdMock.mockReset()
    openPopupWithOriginBarMock.mockReset()
    browserManager.unregisterAll()
    browserManager.setBrowserGuestStateChangedListener(null)
    browserManager.setDictationShortcutForwardingPredicate(null)
    browserManager.setSettingsResolver(() => ({}))
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

  it('keeps featureless window.open popups in-app for every disposition', () => {
    // Regression guard for the reverted #8332: gating the allow on
    // disposition === 'new-window' silently broke featureless window.open()
    // OAuth flows (disposition 'foreground-tab'), whose returned handle must
    // stay live. Disposition is a UX hint, not a trust signal.
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
    for (const disposition of ['foreground-tab', 'background-tab', 'new-window']) {
      expect(
        handler({ url: 'https://sso.example.com/auth', frameName: '', features: '', disposition })
      ).toMatchObject({ action: 'allow' })
    }
    expect(shellOpenExternalMock).not.toHaveBeenCalled()
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

  it('remembers the registered session profile for a browser page', () => {
    const guest = {
      id: 104,
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
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      webContentsId: guest.id,
      rendererWebContentsId,
      sessionProfileId: 'work'
    })

    expect(browserManager.getSessionProfileIdForTab('browser-1')).toBe('work')
  })

  it('tracks offscreen load failures for the owning worktree snapshot', () => {
    const stateChanged = vi.fn()
    const offscreenGuest = {
      id: 605,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'window'),
      setBackgroundThrottling: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      getURL: vi.fn(() => 'https://localhost:3443/')
    }
    webContentsFromIdMock.mockReturnValue(offscreenGuest)
    browserManager.setBrowserGuestStateChangedListener(stateChanged)

    browserManager.registerOffscreenGuest({
      browserPageId: 'offscreen-page',
      worktreeId: 'remote-worktree',
      webContentsId: offscreenGuest.id
    })
    const didFailLoad = offscreenGuest.on.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean
    ) => void
    didFailLoad(null, -202, 'Certificate authority invalid', 'https://localhost:3443/', true)

    expect(browserManager.getBrowserPageLoadError('offscreen-page')).toEqual({
      code: -202,
      description: 'Certificate authority invalid',
      validatedUrl: 'https://localhost:3443/'
    })
    expect(stateChanged).toHaveBeenCalledWith('remote-worktree')
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

  it('activates the owning browser workspace when ensuring a page-backed guest is visible', async () => {
    const rendererExecuteJavaScriptMock = vi
      .fn()
      .mockResolvedValueOnce({
        prevTabType: 'terminal',
        prevActiveWorktreeId: 'wt-1',
        prevActiveBrowserWorkspaceId: 'workspace-prev',
        prevActiveBrowserPageId: 'page-prev',
        prevFocusedGroupTabId: 'tab-prev',
        targetWorktreeId: 'wt-1',
        targetBrowserWorkspaceId: 'workspace-1',
        targetBrowserPageId: 'page-1'
      })
      .mockResolvedValueOnce(undefined)
    const guest = {
      id: 707,
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
      executeJavaScript: rendererExecuteJavaScriptMock
    }
    browserWindowFromWebContentsMock.mockReturnValue({ isFocused: vi.fn(() => true) })
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
      browserPageId: 'page-1',
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const restore = await browserManager.ensureWebviewVisible(guest.id)

    const activationScript = rendererExecuteJavaScriptMock.mock.calls[0]?.[0]
    expect(activationScript).toContain('var browserWorkspaceId = "workspace-1";')
    expect(activationScript).toContain('var browserPageId = "page-1";')
    expect(activationScript).toContain('state.setActiveBrowserTab(browserWorkspaceId);')
    expect(activationScript).toContain(
      'state.setActiveBrowserPage(browserWorkspaceId, browserPageId);'
    )
    expect(activationScript).toContain('var targetWorktreeId = "wt-1";')

    restore()
  })

  it('acquires renderer automation visibility without changing active browser state', async () => {
    const rendererExecuteJavaScriptMock = vi
      .fn()
      .mockResolvedValueOnce('lease-1')
      .mockResolvedValueOnce(true)
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
      executeJavaScript: rendererExecuteJavaScriptMock
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
      browserPageId: 'page-automation',
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const restore = await browserManager.acquireAutomationVisibility(guest.id)
    const acquireScript = rendererExecuteJavaScriptMock.mock.calls[0]?.[0]
    expect(acquireScript).toContain('__orcaBrowserAutomationVisibility')
    expect(acquireScript).toContain('bridge.acquire("page-automation")')
    expect(acquireScript).not.toContain('setActiveBrowserTab')
    expect(acquireScript).not.toContain('setActiveTabType')

    restore()

    const releaseScript = rendererExecuteJavaScriptMock.mock.calls[1]?.[0]
    expect(releaseScript).toContain('bridge.release("lease-1")')
  })

  it('returns a no-op automation visibility restore when renderer acquire hangs', async () => {
    vi.useFakeTimers()

    const rendererExecuteJavaScriptMock = vi.fn().mockReturnValueOnce(new Promise(() => {}))
    const guest = {
      id: 1708,
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
      executeJavaScript: rendererExecuteJavaScriptMock
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
      browserPageId: 'page-hung-acquire',
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const restorePromise = browserManager.acquireAutomationVisibility(guest.id)
    await vi.advanceTimersByTimeAsync(2_000)
    const restore = await restorePromise

    restore()

    expect(rendererExecuteJavaScriptMock).toHaveBeenCalledTimes(1)
  })

  it('releases a delayed automation visibility token after acquire timeout', async () => {
    vi.useFakeTimers()

    let resolveAcquire: (token: string) => void = () => {}
    const acquirePromise = new Promise<string>((resolve) => {
      resolveAcquire = resolve
    })
    const rendererExecuteJavaScriptMock = vi
      .fn()
      .mockReturnValueOnce(acquirePromise)
      .mockResolvedValueOnce(true)
    const guest = {
      id: 1709,
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
      executeJavaScript: rendererExecuteJavaScriptMock
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
      browserPageId: 'page-delayed-acquire',
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const restorePromise = browserManager.acquireAutomationVisibility(guest.id)
    await vi.advanceTimersByTimeAsync(2_000)
    const restore = await restorePromise

    restore()
    expect(rendererExecuteJavaScriptMock).toHaveBeenCalledTimes(1)

    resolveAcquire('late-lease-1')
    await Promise.resolve()
    await Promise.resolve()

    expect(rendererExecuteJavaScriptMock).toHaveBeenCalledTimes(2)
    const releaseScript = rendererExecuteJavaScriptMock.mock.calls[1]?.[0]
    expect(releaseScript).toContain('bridge.release("late-lease-1")')
  })

  it('restores the previously focused browser workspace after screenshot prep changes tabs', async () => {
    const rendererExecuteJavaScriptMock = vi
      .fn()
      .mockResolvedValueOnce({
        prevTabType: 'browser',
        prevActiveWorktreeId: 'wt-prev',
        prevActiveBrowserWorkspaceId: 'workspace-prev',
        prevActiveBrowserPageId: 'page-prev',
        prevFocusedGroupTabId: 'tab-prev',
        targetWorktreeId: 'wt-target',
        targetBrowserWorkspaceId: 'workspace-target',
        targetBrowserPageId: 'page-target'
      })
      .mockResolvedValueOnce(undefined)
    const guest = {
      id: 708,
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
      executeJavaScript: rendererExecuteJavaScriptMock
    }
    browserWindowFromWebContentsMock.mockReturnValue({ isFocused: vi.fn(() => true) })
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
      browserPageId: 'page-target',
      workspaceId: 'workspace-target',
      worktreeId: 'wt-target',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const restore = await browserManager.ensureWebviewVisible(guest.id)
    restore()

    const restoreScript = rendererExecuteJavaScriptMock.mock.calls[1]?.[0]
    expect(restoreScript).toContain('state.setActiveWorktree("wt-prev");')
    expect(restoreScript).toContain('state.setActiveBrowserTab("workspace-prev");')
  })

  it('restores the previously active page when screenshot prep switches pages inside one workspace', async () => {
    const rendererExecuteJavaScriptMock = vi
      .fn()
      .mockResolvedValueOnce({
        prevTabType: 'browser',
        prevActiveWorktreeId: 'wt-target',
        prevActiveBrowserWorkspaceId: 'workspace-target',
        prevActiveBrowserPageId: 'page-prev',
        prevFocusedGroupTabId: null,
        targetWorktreeId: 'wt-target',
        targetBrowserWorkspaceId: 'workspace-target',
        targetBrowserPageId: 'page-target'
      })
      .mockResolvedValueOnce(undefined)
    const guest = {
      id: 709,
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
      executeJavaScript: rendererExecuteJavaScriptMock
    }
    browserWindowFromWebContentsMock.mockReturnValue({ isFocused: vi.fn(() => true) })
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
      browserPageId: 'page-target',
      workspaceId: 'workspace-target',
      worktreeId: 'wt-target',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const restore = await browserManager.ensureWebviewVisible(guest.id)
    restore()

    const restoreScript = rendererExecuteJavaScriptMock.mock.calls[1]?.[0]
    expect(restoreScript).toContain('state.setActiveBrowserPage(')
    expect(restoreScript).toContain('"workspace-target"')
    expect(restoreScript).toContain('"page-prev"')
  })

  it('restores remembered browser workspace/page even when the visible pane was terminal', async () => {
    const rendererExecuteJavaScriptMock = vi
      .fn()
      .mockResolvedValueOnce({
        prevTabType: 'terminal',
        prevActiveWorktreeId: 'wt-target',
        prevActiveBrowserWorkspaceId: 'workspace-prev',
        prevActiveBrowserPageId: 'page-prev',
        prevFocusedGroupTabId: 'tab-prev',
        targetWorktreeId: 'wt-target',
        targetBrowserWorkspaceId: 'workspace-target',
        targetBrowserPageId: 'page-target'
      })
      .mockResolvedValueOnce(undefined)
    const guest = {
      id: 7091,
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
      executeJavaScript: rendererExecuteJavaScriptMock
    }
    browserWindowFromWebContentsMock.mockReturnValue({ isFocused: vi.fn(() => true) })
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
      browserPageId: 'page-target',
      workspaceId: 'workspace-target',
      worktreeId: 'wt-target',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const restore = await browserManager.ensureWebviewVisible(guest.id)
    restore()

    const restoreScript = rendererExecuteJavaScriptMock.mock.calls[1]?.[0]
    expect(restoreScript).toContain('state.setActiveBrowserTab("workspace-prev");')
    expect(restoreScript).toContain('state.setActiveBrowserPage(')
    expect(restoreScript).toContain('"workspace-prev"')
    expect(restoreScript).toContain('"page-prev"')
    expect(restoreScript).toContain('state.activateTab("tab-prev");')
    expect(restoreScript).toContain('state.setActiveTabType("terminal");')
  })

  it('does not focus the Orca window while preparing a screenshot', async () => {
    const rendererExecuteJavaScriptMock = vi.fn().mockResolvedValueOnce({
      prevTabType: 'terminal',
      prevActiveWorktreeId: 'wt-1',
      prevActiveBrowserWorkspaceId: 'workspace-prev',
      prevActiveBrowserPageId: 'page-prev',
      prevFocusedGroupTabId: 'tab-prev',
      targetWorktreeId: 'wt-1',
      targetBrowserWorkspaceId: 'workspace-1',
      targetBrowserPageId: 'page-1'
    })
    const guest = {
      id: 710,
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
      executeJavaScript: rendererExecuteJavaScriptMock
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
      browserPageId: 'page-1',
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    await browserManager.ensureWebviewVisible(guest.id)

    expect(browserWindowFromWebContentsMock).not.toHaveBeenCalled()
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

  it('blocks non-web guest navigations after attach', () => {
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

    const willNavigateHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'will-navigate'
    )?.[1] as ((event: { preventDefault: () => void }, url: string) => void) | undefined

    expect(willNavigateHandler).toBeTypeOf('function')
    const preventDefault = vi.fn()
    willNavigateHandler?.({ preventDefault }, 'file:///etc/passwd')
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('unregisterAll clears tracked guests and context-menu listeners', () => {
    const guest = {
      id: 101,
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
      webContentsId: 101,
      // Why: registrations now record which renderer owns each guest so main
      // can route load failures back to the correct window instead of dropping
      // them once multiple renderers exist.
      rendererWebContentsId
    })
    browserManager.attachGuestPolicies({ ...guest, id: 102 } as never)
    browserManager.registerGuest({
      browserPageId: 'browser-2',
      webContentsId: 102,
      rendererWebContentsId
    })
    // Why: attach-before-registration teardown skips unregisterGuest, so global
    // cleanup must independently release the private click-routing token.
    browserManager.attachGuestPolicies({ ...guest, id: 103 } as never)

    browserManager.unregisterAll()

    expect(browserManager.getGuestWebContentsId('browser-1')).toBeNull()
    expect(browserManager.getGuestWebContentsId('browser-2')).toBeNull()
    expect(guestOffMock).toHaveBeenCalled()
    const managerState = browserManager as unknown as {
      clickedLinkFrameNameByGuestId: Map<number, unknown>
    }
    expect(managerState.clickedLinkFrameNameByGuestId.size).toBe(0)
  })

  it('rejects non-webview guest types to prevent privilege escalation', () => {
    // A compromised renderer could send the main window's own webContentsId.
    // registerGuest must reject it because getType() would return 'window',
    // not 'webview'.
    const mainWindowContents = {
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'window'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockReturnValue(mainWindowContents)

    browserManager.registerGuest({
      browserPageId: 'browser-evil',
      webContentsId: 1,
      rendererWebContentsId
    })

    // The guest should NOT be registered
    expect(browserManager.getGuestWebContentsId('browser-evil')).toBeNull()
    // setWindowOpenHandler must NOT have been called on the main window's webContents
    expect(guestSetWindowOpenHandlerMock).not.toHaveBeenCalled()
  })

  it('rejects registration for guests that never received attach-time policy wiring', () => {
    const guest = {
      id: 777,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: 777,
      rendererWebContentsId
    })

    expect(browserManager.getGuestWebContentsId('browser-1')).toBeNull()
    expect(menuBuildFromTemplateMock).not.toHaveBeenCalled()
  })

  it('does not duplicate guest policy listeners when attach is reported twice', () => {
    const guest = {
      id: 303,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }

    browserManager.attachGuestPolicies(guest as never)
    browserManager.attachGuestPolicies(guest as never)

    expect(guestSetBackgroundThrottlingMock).toHaveBeenCalledTimes(1)
    expect(guestSetWindowOpenHandlerMock).toHaveBeenCalledTimes(1)
    expect(guestOnMock.mock.calls.filter(([event]) => event === 'will-navigate')).toHaveLength(1)
    expect(guestOnMock.mock.calls.filter(([event]) => event === 'will-redirect')).toHaveLength(1)
    expect(guestOnMock.mock.calls.filter(([event]) => event === 'did-create-window')).toHaveLength(
      1
    )
  })

  it('attaches guest policies to created popup child windows', () => {
    const rendererSendMock = vi.fn()
    const childSetBackgroundThrottlingMock = vi.fn()
    const childSetWindowOpenHandlerMock = vi.fn()
    const childOnMock = vi.fn()
    const childOffMock = vi.fn()
    const childOpenDevToolsMock = vi.fn()
    const childGuest = {
      id: 4040,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: childSetBackgroundThrottlingMock,
      setWindowOpenHandler: childSetWindowOpenHandlerMock,
      on: childOnMock,
      off: childOffMock,
      openDevTools: childOpenDevToolsMock
    }
    const guest = {
      id: 404,
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

    const didCreateWindowHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-create-window'
    )?.[1] as ((window: { webContents: typeof childGuest }) => void) | undefined
    expect(didCreateWindowHandler).toBeTypeOf('function')

    didCreateWindowHandler?.({ webContents: childGuest })

    expect(childSetBackgroundThrottlingMock).toHaveBeenCalledWith(false)
    expect(childSetWindowOpenHandlerMock).toHaveBeenCalledTimes(1)
    expect(childOnMock.mock.calls.filter(([event]) => event === 'did-create-window')).toHaveLength(
      1
    )
    expect(childOnMock.mock.calls.filter(([event]) => event === 'will-navigate')).toHaveLength(1)
    expect(childOnMock.mock.calls.filter(([event]) => event === 'will-redirect')).toHaveLength(1)

    const childWindowOpenHandler = childSetWindowOpenHandlerMock.mock.calls[0][0] as (details: {
      url: string
    }) => { action: 'allow' | 'deny' }
    expect(childWindowOpenHandler({ url: 'https://identity.example.com/login' })).toMatchObject({
      action: 'allow'
    })
    expect(childWindowOpenHandler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-1',
      origin: 'null',
      action: 'blocked'
    })
    browserManager.notifyPermissionDenied({
      guestWebContentsId: childGuest.id,
      permission: 'notifications',
      rawUrl: 'https://identity.example.com/login'
    })
    expect(rendererSendMock).toHaveBeenCalledWith('browser:permission-denied', {
      browserPageId: 'browser-1',
      permission: 'notifications',
      origin: 'https://identity.example.com'
    })

    const childDidFailLoadHandler = childOnMock.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as
      | ((
          event: Electron.Event,
          errorCode: number,
          errorDescription: string,
          validatedURL: string,
          isMainFrame: boolean
        ) => void)
      | undefined
    childDidFailLoadHandler?.(
      {} as Electron.Event,
      -105,
      'Name not resolved',
      'https://identity.example.com/unavailable',
      true
    )
    expect(rendererSendMock).not.toHaveBeenCalledWith(
      'browser:guest-load-failed',
      expect.anything()
    )

    const childDownloadItem = createDownloadItem()
    browserManager.handleGuestWillDownload({
      guestWebContentsId: childGuest.id,
      item: childDownloadItem
    })
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-requested',
      expect.objectContaining({ browserPageId: 'browser-1' })
    )
    const childDownloadDoneHandler = getDownloadItemEventHandler(childDownloadItem, 'once', 'done')
    childDownloadDoneHandler?.({} as Electron.Event, 'completed')

    const managerState = browserManager as unknown as {
      popupOwnerContextByGuestId: Map<number, unknown>
    }
    expect(managerState.popupOwnerContextByGuestId.has(childGuest.id)).toBe(true)

    const cleanupChildOnMock = vi.fn()
    const cleanupChildGuest = {
      ...childGuest,
      id: 4041,
      on: cleanupChildOnMock,
      off: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
    const childDidCreateWindowHandler = childOnMock.mock.calls.find(
      ([event]) => event === 'did-create-window'
    )?.[1] as ((window: { webContents: typeof cleanupChildGuest }) => void) | undefined
    childDidCreateWindowHandler?.({ webContents: cleanupChildGuest })
    expect(managerState.popupOwnerContextByGuestId.has(cleanupChildGuest.id)).toBe(true)
    const cleanupChildWindowOpenHandler = cleanupChildGuest.setWindowOpenHandler.mock
      .calls[0][0] as (details: { url: string }) => { action: 'allow' | 'deny' }
    expect(
      cleanupChildWindowOpenHandler({ url: 'https://identity.example.com/continue' })
    ).toMatchObject({ action: 'allow' })
    const cleanupChildDestroyedHandler = cleanupChildOnMock.mock.calls.find(
      ([event]) => event === 'destroyed'
    )?.[1] as (() => void) | undefined
    cleanupChildDestroyedHandler?.()
    expect(managerState.popupOwnerContextByGuestId.has(cleanupChildGuest.id)).toBe(false)

    const replacementGuest = {
      ...guest,
      id: 405,
      on: vi.fn(),
      off: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === replacementGuest.id) {
        return replacementGuest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })
    browserManager.attachGuestPolicies(replacementGuest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: replacementGuest.id,
      rendererWebContentsId
    })

    expect(childWindowOpenHandler({ url: 'https://identity.example.com/next' })).toEqual({
      action: 'deny'
    })
    expect(shellOpenExternalMock).toHaveBeenCalledWith('https://identity.example.com/next')
    expect(managerState.popupOwnerContextByGuestId.has(childGuest.id)).toBe(false)

    const childDestroyedHandler = childOnMock.mock.calls.find(
      ([event]) => event === 'destroyed'
    )?.[1] as (() => void) | undefined
    childDestroyedHandler?.()
    expect(managerState.popupOwnerContextByGuestId.has(childGuest.id)).toBe(false)

    browserManager.unregisterAll()

    expect(childOffMock).toHaveBeenCalledWith('did-create-window', expect.any(Function))
    expect(childOffMock).toHaveBeenCalledWith('will-navigate', expect.any(Function))
    expect(childOffMock).toHaveBeenCalledWith('will-redirect', expect.any(Function))
  })

  it('cleans attached guest policy state when a guest is destroyed before registration', () => {
    const guest = {
      id: 304,
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

    const destroyedHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'destroyed'
    )?.[1] as (() => void) | undefined
    expect(destroyedHandler).toBeTypeOf('function')

    destroyedHandler?.()
    browserManager.registerGuest({
      browserPageId: 'browser-destroyed-before-register',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    expect(browserManager.getGuestWebContentsId('browser-destroyed-before-register')).toBeNull()
  })

  it('removes a destroyed primary guest from its tab registration maps', () => {
    const guest = {
      id: 306,
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
      browserPageId: 'browser-destroyed-after-register',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const destroyedHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'destroyed'
    )?.[1] as (() => void) | undefined
    destroyedHandler?.()

    expect(browserManager.getGuestWebContentsId('browser-destroyed-after-register')).toBeNull()
    const managerState = browserManager as unknown as {
      tabIdByWebContentsId: Map<number, string>
    }
    expect(managerState.tabIdByWebContentsId.has(guest.id)).toBe(false)
  })

  it('fully unregisters stale guests discovered during authorization', () => {
    const guest = {
      id: 305,
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
      browserPageId: 'browser-stale',
      workspaceId: 'workspace-stale',
      worktreeId: 'worktree-stale',
      sessionProfileId: 'profile-stale',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const internals = browserManager as unknown as {
      rendererWebContentsIdByTabId: Map<string, number>
      workspaceIdByPageId: Map<string, string>
      sessionProfileIdByPageId: Map<string, string | null>
      worktreeIdByTabId: Map<string, string>
      contextMenuCleanupByTabId: Map<string, () => void>
      grabShortcutCleanupByTabId: Map<string, () => void>
      shortcutForwardingCleanupByTabId: Map<string, () => void>
    }
    expect(internals.rendererWebContentsIdByTabId.has('browser-stale')).toBe(true)
    expect(internals.workspaceIdByPageId.has('browser-stale')).toBe(true)
    expect(internals.sessionProfileIdByPageId.has('browser-stale')).toBe(true)
    expect(internals.worktreeIdByTabId.has('browser-stale')).toBe(true)
    expect(internals.contextMenuCleanupByTabId.has('browser-stale')).toBe(true)
    expect(internals.grabShortcutCleanupByTabId.has('browser-stale')).toBe(true)
    expect(internals.shortcutForwardingCleanupByTabId.has('browser-stale')).toBe(true)

    webContentsFromIdMock.mockReturnValue(null)

    expect(browserManager.getAuthorizedGuest('browser-stale', rendererWebContentsId)).toBeNull()

    expect(browserManager.getGuestWebContentsId('browser-stale')).toBeNull()
    expect(internals.rendererWebContentsIdByTabId.has('browser-stale')).toBe(false)
    expect(internals.workspaceIdByPageId.has('browser-stale')).toBe(false)
    expect(internals.sessionProfileIdByPageId.has('browser-stale')).toBe(false)
    expect(internals.worktreeIdByTabId.has('browser-stale')).toBe(false)
    expect(internals.contextMenuCleanupByTabId.has('browser-stale')).toBe(false)
    expect(internals.grabShortcutCleanupByTabId.has('browser-stale')).toBe(false)
    expect(internals.shortcutForwardingCleanupByTabId.has('browser-stale')).toBe(false)
    expect(guestOffMock).toHaveBeenCalled()
  })

  it('replays a queued main-frame load failure after the guest registers', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 404,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'http://localhost:3000/'),
      ...guestUaMethods()
    }

    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === 404) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return {
          isDestroyed: vi.fn(() => false),
          send: rendererSendMock
        }
      }
      return null
    })

    browserManager.attachGuestPolicies(guest as never)

    const didFailLoadHandler = guestOnMock.mock.calls.find(
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

    expect(didFailLoadHandler).toBeTypeOf('function')
    didFailLoadHandler?.(null, -105, 'Name not resolved', 'http://localhost:3000/', true)

    expect(rendererSendMock).not.toHaveBeenCalled()

    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: 404,
      rendererWebContentsId
    })

    expect(rendererSendMock).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenCalledWith('browser:guest-load-failed', {
      browserPageId: 'browser-1',
      loadError: {
        code: -105,
        description: 'Name not resolved',
        validatedUrl: 'http://localhost:3000/'
      }
    })
    expect(browserManager.getBrowserPageLoadError('browser-1')).toEqual({
      code: -105,
      description: 'Name not resolved',
      validatedUrl: 'http://localhost:3000/'
    })

    const didStartNavigationHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as
      | ((event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void)
      | undefined
    didStartNavigationHandler?.(null, 'http://localhost:3000/retry', false, true)
    expect(browserManager.getBrowserPageLoadError('browser-1')).toBeNull()
  })

  it('drops a queued failure when a replacement navigation starts before registration', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 407,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://example.com/'),
      ...guestUaMethods()
    }
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === guest.id
        ? guest
        : id === rendererWebContentsId
          ? { isDestroyed: vi.fn(() => false), send: rendererSendMock }
          : null
    )

    browserManager.attachGuestPolicies(guest as never)
    const didFailLoad = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean
    ) => void
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

    didFailLoad(null, -202, 'Certificate authority invalid', 'https://localhost:3443/', true)
    didStartNavigation(null, 'https://example.com/', false, true)
    expect(
      browserManager.registerGuest({
        browserPageId: 'browser-late-registration',
        webContentsId: guest.id,
        rendererWebContentsId
      })
    ).toBe(true)

    expect(rendererSendMock).not.toHaveBeenCalledWith(
      'browser:guest-load-failed',
      expect.anything()
    )
    expect(browserManager.getBrowserPageLoadError('browser-late-registration')).toBeNull()
  })

  it('keeps a certificate failure until a real main-frame navigation starts', () => {
    const guest = {
      id: 405,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      send: vi.fn(),
      getURL: vi.fn(() => 'chrome-error://chromewebdata/'),
      ...guestUaMethods()
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    const didFailLoad = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean
    ) => void

    browserManager.registerGuest({
      browserPageId: 'browser-certificate-page',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    didFailLoad(null, -202, 'Certificate authority invalid', 'https://localhost:3443/', true)
    didStartNavigation(null, 'chrome-error://chromewebdata/', false, true)
    expect(browserManager.getBrowserPageLoadError('browser-certificate-page')?.code).toBe(-202)

    didStartNavigation(null, 'https://localhost:3443/', false, true)
    expect(browserManager.getBrowserPageLoadError('browser-certificate-page')).toBeNull()
  })

  it('restores a certificate failure when a retry navigation aborts before committing', () => {
    const guest = {
      id: 406,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      send: vi.fn(),
      getURL: vi.fn(() => 'chrome-error://chromewebdata/'),
      ...guestUaMethods()
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    const didFailLoad = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean
    ) => void

    browserManager.registerGuest({
      browserPageId: 'browser-retry-abort-page',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    didFailLoad(null, -202, 'Certificate authority invalid', 'https://localhost:3443/', true)
    // Retry: the new navigation starts (overlay optimistically cleared)...
    didStartNavigation(null, 'https://localhost:3443/', false, true)
    expect(browserManager.getBrowserPageLoadError('browser-retry-abort-page')).toBeNull()
    // ...then aborts (ERR_ABORTED) before committing, so the error is restored.
    didFailLoad(null, -3, 'Aborted', 'https://localhost:3443/', true)
    expect(browserManager.getBrowserPageLoadError('browser-retry-abort-page')?.code).toBe(-202)

    // A fresh navigation from a non-errored state drops the stash, so a later
    // abort cannot resurrect the old error.
    didStartNavigation(null, 'https://localhost:3443/', false, true) // stashes -202, clears active
    didStartNavigation(null, 'https://example.com/', false, true) // active empty -> drops stash
    didFailLoad(null, -3, 'Aborted', 'https://example.com/', true)
    expect(browserManager.getBrowserPageLoadError('browser-retry-abort-page')).toBeNull()
  })

  it('presents the Firefox UA on Google auth hosts and restores the base UA off them', () => {
    let currentUa = guestBaseUserAgent
    const setUserAgent = vi.fn((ua: string) => {
      currentUa = ua
    })
    const guest = {
      id: 408,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://accounts.google.com/'),
      getUserAgent: vi.fn(() => currentUa),
      setUserAgent,
      session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-auth-ua',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    setUserAgent.mockClear()

    didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
    expect(setUserAgent).toHaveBeenLastCalledWith(googleAuthUserAgent())

    // Off the auth host, the guest's base identity is restored.
    didStartNavigation(null, 'https://myaccount.google.com/', false, true)
    expect(setUserAgent).toHaveBeenLastCalledWith(guestBaseUserAgent)

    // A navigation that doesn't change the required UA must not thrash setUserAgent.
    setUserAgent.mockClear()
    didStartNavigation(null, 'https://example.com/', false, true)
    expect(setUserAgent).not.toHaveBeenCalled()
  })

  it('leaves the UA untouched on Google auth hosts for native-UA profiles', () => {
    const setUserAgent = vi.fn()
    const guest = {
      id: 409,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://accounts.google.com/'),
      getUserAgent: vi.fn(() => guestBaseUserAgent),
      setUserAgent,
      session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-native-ua',
      webContentsId: guest.id,
      rendererWebContentsId,
      userAgentMode: 'native'
    })
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    setUserAgent.mockClear()

    didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
    expect(setUserAgent).not.toHaveBeenCalled()
  })

  it('honors native session mode before the guest registration IPC arrives', () => {
    const nativeSession = { getUserAgent: vi.fn(() => guestBaseUserAgent) }
    setBrowserSessionUserAgentMode(nativeSession as never, 'native')
    const setUserAgent = vi.fn()
    const guest = {
      id: 417,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://accounts.google.com/'),
      getUserAgent: vi.fn(() => guestBaseUserAgent),
      setUserAgent,
      session: nativeSession
    }

    browserManager.attachGuestPolicies(guest as never)
    const didStartNavigation = guestOnMock.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

    didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
    expect(setUserAgent).not.toHaveBeenCalled()
  })

  // Why: popup child windows get attachGuestPolicies but are never entered into tabIdByWebContentsId,
  // so a direct lookup of the UA mode misses the native opt-out. That is worse than doing nothing —
  // native sessions skip setupClientHintsOverride, so the popup would send the raw Electron UA on the
  // wire while navigator.userAgent claimed Firefox. Google sign-in popups are a first-class surface.
  it('leaves the UA untouched on auth hosts for a popup owned by a native-UA profile', () => {
    const ownerGuest = {
      id: 415,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://accounts.google.com/'),
      getUserAgent: vi.fn(() => guestBaseUserAgent),
      setUserAgent: vi.fn(),
      session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
    }
    webContentsFromIdMock.mockReturnValue(ownerGuest)
    browserManager.attachGuestPolicies(ownerGuest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-native-popup-owner',
      webContentsId: ownerGuest.id,
      rendererWebContentsId,
      userAgentMode: 'native'
    })

    // The popup carries its own listeners so its handler is unambiguous.
    const popupOn = vi.fn()
    const popupSetUserAgent = vi.fn()
    const popupGuest = {
      id: 416,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'window'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: popupOn,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://accounts.google.com/'),
      getUserAgent: vi.fn(() => guestBaseUserAgent),
      setUserAgent: popupSetUserAgent,
      session: { getUserAgent: vi.fn(() => guestBaseUserAgent) }
    }
    browserManager.attachGuestPolicies(popupGuest as never, {
      browserTabId: 'browser-native-popup-owner',
      rootGuestWebContentsId: ownerGuest.id
    })

    const popupDidStartNavigation = popupOn.mock.calls.find(
      ([event]) => event === 'did-start-navigation'
    )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    expect(popupDidStartNavigation).toBeDefined()

    popupDidStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
    expect(popupSetUserAgent).not.toHaveBeenCalled()
  })

  it('queues permission denials and download requests until the guest registers', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 407,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const item = {
      setSavePath: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      cancel: vi.fn(),
      getFilename: vi.fn(() => 'report.csv'),
      getTotalBytes: vi.fn(() => 2048),
      getMimeType: vi.fn(() => 'text/csv'),
      getURL: vi.fn(() => 'https://example.com/report.csv'),
      getReceivedBytes: vi.fn(() => 0)
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
    browserManager.notifyPermissionDenied({
      guestWebContentsId: guest.id,
      permission: 'media',
      rawUrl: 'https://example.com/account'
    })
    browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item: item as never })

    expect(rendererSendMock).not.toHaveBeenCalled()

    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    expect(rendererSendMock).toHaveBeenCalledWith('browser:permission-denied', {
      browserPageId: 'browser-1',
      permission: 'media',
      origin: 'https://example.com'
    })
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-requested',
      expect.objectContaining({
        browserPageId: 'browser-1',
        filename: 'report.csv',
        origin: 'https://example.com',
        totalBytes: 2048,
        mimeType: 'text/csv',
        savePath: join('/downloads', 'report.csv'),
        status: 'downloading'
      })
    )
    expect(item.setSavePath).toHaveBeenCalledWith(join('/downloads', 'report.csv'))
  })

  it('sets the download save path immediately and reports progress and completion', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 408,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const item = createDownloadItem()
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
    browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item })

    expect(item.setSavePath).toHaveBeenCalledWith(join('/downloads', 'report.csv'))
    expect(item.on).toHaveBeenCalledWith('updated', expect.any(Function))
    expect(item.once).toHaveBeenCalledWith('done', expect.any(Function))
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-requested',
      expect.objectContaining({
        browserPageId: 'browser-1',
        filename: 'report.csv',
        savePath: join('/downloads', 'report.csv'),
        status: 'downloading'
      })
    )

    vi.mocked(item.getReceivedBytes).mockReturnValue(1024)
    const updatedHandler = getDownloadItemEventHandler(item, 'on', 'updated')
    updatedHandler?.({} as Electron.Event, 'progressing')

    expect(rendererSendMock).toHaveBeenCalledWith('browser:download-progress', {
      browserPageId: 'browser-1',
      downloadId: expect.any(String),
      receivedBytes: 1024,
      totalBytes: 2048,
      state: 'progressing'
    })

    const doneHandler = getDownloadItemEventHandler(item, 'once', 'done')
    doneHandler?.({} as Electron.Event, 'completed')

    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-finished',
      expect.objectContaining({
        browserPageId: 'browser-1',
        status: 'completed',
        savePath: join('/downloads', 'report.csv'),
        error: null
      })
    )
  })

  it('flushes started and terminal snapshots for downloads that finish before registration', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 409,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const item = createDownloadItem()
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
    browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item })

    const doneHandler = getDownloadItemEventHandler(item, 'once', 'done')
    doneHandler?.({} as Electron.Event, 'completed')

    expect(rendererSendMock).not.toHaveBeenCalled()

    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    expect(rendererSendMock.mock.calls.map(([channel]) => channel)).toEqual([
      'browser:download-requested',
      'browser:download-finished'
    ])
  })

  it('drops pending download records when an unregistered guest is destroyed', () => {
    const guest = {
      id: 412,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const item = createDownloadItem()
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item })

    const managerState = browserManager as unknown as { downloadsById: Map<string, unknown> }
    expect(managerState.downloadsById.size).toBe(1)

    const destroyedHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'destroyed'
    )?.[1] as (() => void) | undefined
    destroyedHandler?.()

    expect(item.cancel).toHaveBeenCalledTimes(1)
    expect(managerState.downloadsById.size).toBe(0)
  })

  it('cancels active downloads when the owning browser tab closes', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 410,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const item = createDownloadItem()
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
    browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item })

    browserManager.unregisterGuest('browser-1')

    expect(item.cancel).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-finished',
      expect.objectContaining({
        browserPageId: 'browser-1',
        status: 'canceled',
        error: 'Tab closed before download completed.'
      })
    )
  })

  it('reports setSavePath failures without leaving a hidden download running', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 411,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const item = createDownloadItem({
      setSavePath: vi.fn(() => {
        throw new Error('cannot set path')
      }) as never
    })
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
    browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item })

    expect(item.cancel).toHaveBeenCalledTimes(1)
    expect(rendererSendMock.mock.calls.map(([channel]) => channel)).toEqual([
      'browser:download-requested',
      'browser:download-finished'
    ])
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-finished',
      expect.objectContaining({
        status: 'failed',
        error: 'Failed to set download destination.'
      })
    )
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
  })

  it('does not forward ctrl/cmd+r or readline chords from browser guests', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 405,
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

    const beforeInputHandler = guestOnMock.mock.calls.findLast(
      ([event]) => event === 'before-input-event'
    )?.[1] as
      | ((event: { preventDefault: () => void }, input: Record<string, unknown>) => void)
      | undefined

    expect(beforeInputHandler).toBeTypeOf('function')

    // Why: on Linux, Ctrl is the shortcut modifier, so Ctrl+R is the reload
    // shortcut (not a readline chord). Only test Ctrl+R as a readline passthrough
    // on macOS where Cmd is the modifier and Ctrl+R is genuinely a readline chord.
    const readlineChords = [
      ...(process.platform === 'darwin'
        ? [
            {
              type: 'keyDown',
              code: 'KeyR',
              key: 'r',
              meta: false,
              control: true,
              alt: false,
              shift: false
            }
          ]
        : []),
      {
        type: 'keyDown',
        code: 'KeyU',
        key: 'u',
        meta: false,
        control: true,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyE',
        key: 'e',
        meta: false,
        control: true,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyJ',
        key: 'j',
        meta: false,
        control: true,
        alt: false,
        shift: false
      }
    ]
    for (const input of readlineChords) {
      const preventDefault = vi.fn()
      beforeInputHandler?.({ preventDefault }, input)
      expect(preventDefault).not.toHaveBeenCalled()
    }

    expect(rendererSendMock).not.toHaveBeenCalled()
  })

  it('forwards browser guest tab shortcuts alongside shared window shortcuts', () => {
    const isDarwin = process.platform === 'darwin'
    const rendererSendMock = vi.fn()
    const guest = {
      id: 406,
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

    const beforeInputHandler = guestOnMock.mock.calls.findLast(
      ([event]) => event === 'before-input-event'
    )?.[1] as
      | ((event: { preventDefault: () => void }, input: Record<string, unknown>) => void)
      | undefined

    expect(beforeInputHandler).toBeTypeOf('function')

    const inputs = [
      {
        type: 'keyDown',
        code: 'KeyB',
        key: 'b',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: true
      },
      {
        type: 'keyDown',
        code: 'KeyT',
        key: 't',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyW',
        key: 'w',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'BracketRight',
        key: '}',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: true
      },
      {
        type: 'keyDown',
        code: 'BracketRight',
        key: ']',
        meta: isDarwin,
        control: !isDarwin,
        alt: true,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'PageDown',
        key: 'PageDown',
        meta: false,
        control: true,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyP',
        key: 'p',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyL',
        key: 'l',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyR',
        key: 'r',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: false
      },
      {
        type: 'keyDown',
        code: 'KeyR',
        key: 'r',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: true
      }
    ]

    for (const input of inputs) {
      const preventDefault = vi.fn()
      beforeInputHandler?.({ preventDefault }, input)
      expect(preventDefault).toHaveBeenCalledTimes(1)
    }

    expect(rendererSendMock).toHaveBeenNthCalledWith(1, 'ui:newBrowserTab')
    expect(rendererSendMock).toHaveBeenNthCalledWith(2, 'ui:newTerminalTab')
    expect(rendererSendMock).toHaveBeenNthCalledWith(3, 'ui:closeActiveTab')
    expect(rendererSendMock).toHaveBeenNthCalledWith(4, 'ui:switchTabAcrossAllTypes', 1)
    expect(rendererSendMock).toHaveBeenNthCalledWith(5, 'ui:switchTab', 1)
    expect(rendererSendMock).toHaveBeenNthCalledWith(6, 'ui:switchTerminalTab', 1)
    expect(rendererSendMock).toHaveBeenNthCalledWith(7, 'ui:openQuickOpen')
    expect(rendererSendMock).toHaveBeenNthCalledWith(8, 'ui:focusBrowserAddressBar')
    expect(rendererSendMock).toHaveBeenNthCalledWith(9, 'ui:reloadBrowserPage')
    expect(rendererSendMock).toHaveBeenNthCalledWith(10, 'ui:hardReloadBrowserPage')
  })

  it('uses customized keybindings when forwarding browser guest shortcuts', () => {
    const isDarwin = process.platform === 'darwin'
    const primary = { meta: isDarwin, control: !isDarwin }
    const rendererSendMock = vi.fn()
    const guest = {
      id: 407,
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
    browserManager.setSettingsResolver(() => ({
      keybindings: {
        'tab.newBrowser': ['Mod+Alt+B'],
        'worktree.quickOpen': ['Mod+Shift+O']
      }
    }))

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const beforeInputHandler = guestOnMock.mock.calls.findLast(
      ([event]) => event === 'before-input-event'
    )?.[1] as
      | ((event: { preventDefault: () => void }, input: Record<string, unknown>) => void)
      | undefined

    expect(beforeInputHandler).toBeTypeOf('function')

    const defaultBrowserPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: defaultBrowserPreventDefault },
      {
        type: 'keyDown',
        code: 'KeyB',
        key: 'b',
        ...primary,
        alt: false,
        shift: true
      }
    )
    expect(defaultBrowserPreventDefault).not.toHaveBeenCalled()

    const customBrowserPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: customBrowserPreventDefault },
      {
        type: 'keyDown',
        code: 'KeyB',
        key: 'b',
        ...primary,
        alt: true,
        shift: false
      }
    )
    expect(customBrowserPreventDefault).toHaveBeenCalledTimes(1)

    const defaultQuickOpenPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: defaultQuickOpenPreventDefault },
      {
        type: 'keyDown',
        code: 'KeyP',
        key: 'p',
        ...primary,
        alt: false,
        shift: false
      }
    )
    expect(defaultQuickOpenPreventDefault).not.toHaveBeenCalled()

    const customQuickOpenPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: customQuickOpenPreventDefault },
      {
        type: 'keyDown',
        code: 'KeyO',
        key: 'o',
        ...primary,
        alt: false,
        shift: true
      }
    )
    expect(customQuickOpenPreventDefault).toHaveBeenCalledTimes(1)

    expect(rendererSendMock).toHaveBeenNthCalledWith(1, 'ui:newBrowserTab')
    expect(rendererSendMock).toHaveBeenNthCalledWith(2, 'ui:openQuickOpen')
  })

  it('forwards browser guest Ctrl+Tab keydown and Ctrl release', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 407,
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

    const beforeInputHandler = guestOnMock.mock.calls.findLast(
      ([event]) => event === 'before-input-event'
    )?.[1] as
      | ((event: { preventDefault: () => void }, input: Record<string, unknown>) => void)
      | undefined

    const keyDownPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: keyDownPreventDefault },
      {
        type: 'keyDown',
        code: 'Tab',
        key: 'Tab',
        meta: false,
        control: true,
        alt: false,
        shift: false
      }
    )
    const keyUpPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: keyUpPreventDefault },
      {
        type: 'keyUp',
        code: 'ControlRight',
        key: 'Control',
        meta: false,
        control: false,
        alt: false,
        shift: false
      }
    )

    // Why: keydown must not preventDefault or Electron drops the commit keyup.
    expect(keyDownPreventDefault).not.toHaveBeenCalled()
    expect(keyUpPreventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenNthCalledWith(1, 'ui:ctrlTabKeyDown', { shiftKey: false })
    expect(rendererSendMock).toHaveBeenNthCalledWith(2, 'ui:ctrlTabKeyUp')
  })

  it('respects disabled browser guest tab-switch bindings', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 408,
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
    browserManager.setSettingsResolver(() => ({
      keybindings: {
        'tab.previousRecent': [],
        'tab.nextTerminal': [],
        'tab.previousTerminal': []
      }
    }))

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    const beforeInputHandler = guestOnMock.mock.calls.findLast(
      ([event]) => event === 'before-input-event'
    )?.[1] as
      | ((event: { preventDefault: () => void }, input: Record<string, unknown>) => void)
      | undefined

    const ctrlTabPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: ctrlTabPreventDefault },
      {
        type: 'keyDown',
        code: 'Tab',
        key: 'Tab',
        meta: false,
        control: true,
        alt: false,
        shift: false
      }
    )

    const terminalTabPreventDefault = vi.fn()
    beforeInputHandler?.(
      { preventDefault: terminalTabPreventDefault },
      {
        type: 'keyDown',
        code: 'PageDown',
        key: 'PageDown',
        meta: false,
        control: true,
        alt: false,
        shift: false
      }
    )

    expect(ctrlTabPreventDefault).not.toHaveBeenCalled()
    expect(terminalTabPreventDefault).not.toHaveBeenCalled()
    expect(rendererSendMock).not.toHaveBeenCalledWith('ui:ctrlTabKeyDown', expect.anything())
    expect(rendererSendMock).not.toHaveBeenCalledWith('ui:switchTerminalTab', expect.anything())
  })

  it('cleans up prior guest listeners before re-registering the same tab', () => {
    const guest = {
      id: 808,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://example.com/'),
      navigationHistory: {
        canGoBack: vi.fn(() => false),
        canGoForward: vi.fn(() => false)
      },
      goBack: vi.fn(),
      goForward: vi.fn(),
      reload: vi.fn(),
      executeJavaScript: vi.fn()
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: 808,
      rendererWebContentsId
    })

    guestOffMock.mockClear()

    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: 808,
      rendererWebContentsId
    })

    expect(guestOffMock).toHaveBeenCalledWith('context-menu', expect.any(Function))
    expect(
      guestOffMock.mock.calls.filter(([eventName]) => eventName === 'before-input-event')
    ).toHaveLength(2)
  })

  it('cancels pending anti-detection reattach timers when unregistering a guest', () => {
    vi.useFakeTimers()

    const debuggerHandlers = new Map<string, () => void>()
    const debuggerAttachMock = vi.fn()
    const guest = {
      id: 809,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock,
      getURL: vi.fn(() => 'https://example.com/'),
      debugger: {
        isAttached: vi.fn(() => false),
        attach: debuggerAttachMock,
        sendCommand: vi.fn().mockResolvedValue(undefined),
        on: vi.fn((eventName: string, handler: () => void) => {
          debuggerHandlers.set(eventName, handler)
        }),
        off: vi.fn((eventName: string, handler: () => void) => {
          if (debuggerHandlers.get(eventName) === handler) {
            debuggerHandlers.delete(eventName)
          }
        })
      }
    }
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-reattach',
      webContentsId: 809,
      rendererWebContentsId
    })

    debuggerHandlers.get('detach')?.()
    expect(vi.getTimerCount()).toBe(1)

    browserManager.unregisterGuest('browser-reattach')
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(500)
    expect(debuggerAttachMock).toHaveBeenCalledTimes(1)
  })

  describe('setViewportOverride', () => {
    const GUEST_ELECTRON_UA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/134.0.0.0 Electron/30.0.0 Safari/537.36'
    const GUEST_CLEAN_UA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

    // Why: viewport UA writes are queued on the per-tab chain, so draining it takes more than one
    // microtask hop; loop until the chain is empty rather than guessing a tick count.
    async function flushViewportOps(): Promise<void> {
      for (let i = 0; i < 20; i++) {
        await Promise.resolve()
      }
    }

    function makeGuest(
      id: number,
      url = 'https://example.com/'
    ): {
      guest: Record<string, unknown>
      debuggerSendCommand: ReturnType<typeof vi.fn>
      debuggerIsAttached: ReturnType<typeof vi.fn>
      debuggerAttach: ReturnType<typeof vi.fn>
      setGuestUserAgent: (ua: string) => void
      commitNavigationTo: (nextUrl: string) => void
    } {
      const debuggerSendCommand = vi.fn().mockResolvedValue(undefined)
      const debuggerIsAttached = vi.fn(() => true)
      const debuggerAttach = vi.fn()
      let currentUa = GUEST_ELECTRON_UA
      // Why: getURL() reports the last COMMITTED url — it does not move at did-start-navigation.
      let committedUrl = url
      const guest = {
        id,
        isDestroyed: vi.fn(() => false),
        getType: vi.fn(() => 'webview'),
        getURL: vi.fn(() => committedUrl),
        getUserAgent: vi.fn(() => currentUa),
        setUserAgent: vi.fn((ua: string) => {
          currentUa = ua
        }),
        session: { getUserAgent: vi.fn(() => GUEST_ELECTRON_UA) },
        setBackgroundThrottling: guestSetBackgroundThrottlingMock,
        setWindowOpenHandler: guestSetWindowOpenHandlerMock,
        on: guestOnMock,
        off: guestOffMock,
        openDevTools: guestOpenDevToolsMock,
        executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue(true),
        debugger: {
          isAttached: debuggerIsAttached,
          attach: debuggerAttach,
          sendCommand: debuggerSendCommand
        }
      }
      return {
        guest,
        debuggerSendCommand,
        debuggerIsAttached,
        debuggerAttach,
        setGuestUserAgent: (ua: string) => {
          currentUa = ua
        },
        commitNavigationTo: (nextUrl: string) => {
          committedUrl = nextUrl
        }
      }
    }

    it('returns false when the tab is not registered', async () => {
      const result = await browserManager.setViewportOverride('missing', {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        mobile: true
      })
      expect(result).toBe(false)
    })

    it('applies device metrics, touch emulation, and a mobile UA for mobile presets', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4242)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-mobile',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      webContentsFromIdMock.mockReset()
      webContentsFromIdMock.mockReturnValue(guest)

      const ok = await browserManager.setViewportOverride('tab-mobile', {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        mobile: true
      })
      expect(ok).toBe(true)

      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        mobile: true
      })
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 5
      })
      const uaCall = debuggerSendCommand.mock.calls.find(
        (call) => call[0] === 'Emulation.setUserAgentOverride'
      )
      expect(uaCall).toBeDefined()
      expect(uaCall?.[1]).toMatchObject({
        userAgent: expect.stringContaining('iPhone')
      })
      // Chrome major from the guest UA should be spliced into the mobile UA.
      expect(uaCall?.[1]).toMatchObject({
        userAgent: expect.stringContaining('CriOS/134')
      })
    })

    it.each([false, true])(
      'keeps the session UA for native-mode profiles when mobile=%s',
      async (mobile) => {
        const { guest, debuggerSendCommand } = makeGuest(mobile ? 4244 : 4243)
        webContentsFromIdMock.mockReturnValue(guest)
        browserManager.attachGuestPolicies(guest as never)
        browserManager.registerGuest({
          browserPageId: `tab-native-${mobile}`,
          sessionProfileId: 'native-profile',
          userAgentMode: 'native',
          webContentsId: guest.id as number,
          rendererWebContentsId
        })

        await expect(
          browserManager.setViewportOverride(`tab-native-${mobile}`, {
            width: mobile ? 375 : 1024,
            height: mobile ? 667 : 768,
            deviceScaleFactor: mobile ? 2 : 1,
            mobile
          })
        ).resolves.toBe(true)

        expect(debuggerSendCommand).not.toHaveBeenCalledWith(
          'Emulation.setUserAgentOverride',
          expect.anything()
        )
      }
    )

    // Why: the CDP override outranks setUserAgent for navigator.userAgent, so a preset applied on an
    // auth host must carry the same Firefox identity the header hook sends (verified against real
    // Electron 43: Emulation.setUserAgentOverride wins over WebContents.setUserAgent and stands
    // across every later navigation until explicitly cleared).
    it.each([false, true])(
      'presents the Firefox UA for a preset applied on a Google auth host (mobile=%s)',
      async (mobile) => {
        const { guest, debuggerSendCommand } = makeGuest(
          mobile ? 4246 : 4245,
          'https://accounts.google.com/v3/signin/identifier'
        )
        webContentsFromIdMock.mockReturnValue(guest)
        browserManager.attachGuestPolicies(guest as never)
        browserManager.registerGuest({
          browserPageId: `tab-auth-${mobile}`,
          webContentsId: guest.id as number,
          rendererWebContentsId
        })

        await browserManager.setViewportOverride(`tab-auth-${mobile}`, {
          width: mobile ? 375 : 1024,
          height: mobile ? 667 : 768,
          deviceScaleFactor: mobile ? 2 : 1,
          mobile
        })

        expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
          userAgent: googleAuthUserAgent()
        })
      }
    )

    it('re-issues the standing UA override when navigating onto and back off an auth host', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4247)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-auth-nav',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      // Case A: the desktop preset lands first, while the tab is still off the auth host.
      await browserManager.setViewportOverride('tab-auth-nav', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      expect(debuggerSendCommand).toHaveBeenLastCalledWith('Emulation.setUserAgentOverride', {
        userAgent: GUEST_CLEAN_UA
      })

      // Navigating to the auth host must move the standing override to the Firefox identity.
      debuggerSendCommand.mockClear()
      didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
        userAgent: googleAuthUserAgent()
      })

      // Leaving the auth host restores the clean Chrome-shaped preset UA.
      debuggerSendCommand.mockClear()
      didStartNavigation(null, 'https://example.com/', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
        userAgent: GUEST_CLEAN_UA
      })
    })

    // Why: not an ordering race — debugger.sendCommand dispatches in call order over one channel, so
    // the later-issued write always wins. The defect is post-await staleness: verified against real
    // Electron 43.1.0, did-start-navigation fires while an awaited sendCommand is still pending, and
    // getURL() keeps reporting the OUTGOING page until commit. A preset resuming mid-navigation
    // therefore resolves the wrong host and wins with the wrong value. Both writers must resolve the
    // host from the in-flight navigation target instead.
    function lastUserAgentOverride(
      debuggerSendCommand: ReturnType<typeof vi.fn>
    ): Record<string, unknown> | undefined {
      const calls = debuggerSendCommand.mock.calls.filter(
        (call) => call[0] === 'Emulation.setUserAgentOverride'
      )
      return calls.at(-1)?.[1] as Record<string, unknown> | undefined
    }

    // Why mobile: on the desktop branch the break is masked by coincidence — applyGoogleAuthUserAgent
    // has already switched the WebContents UA to Firefox, and cleanElectronUserAgent passes a Firefox
    // UA through untouched, so the stale-URL desktop path happens to emit Firefox anyway. The mobile
    // branch derives a Chrome-shaped iPhone UA from that same base and exposes the real defect.
    it('does not leave the Chrome preset UA standing when a mobile preset lands mid-navigation onto an auth host', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4251, 'https://example.com/')
      // Hold the preset's first CDP command open so the navigation lands inside its await window.
      let releaseMetrics = (): void => {}
      const metricsGate = new Promise<void>((resolve) => {
        releaseMetrics = () => resolve()
      })
      debuggerSendCommand.mockImplementation((method: string) =>
        method === 'Emulation.setDeviceMetricsOverride' ? metricsGate : Promise.resolve(undefined)
      )
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-race-onto-auth',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      const presetDone = browserManager.setViewportOverride('tab-race-onto-auth', {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        mobile: true
      })
      await flushViewportOps()

      // The tab navigates to the auth host while the preset is still awaiting its first command.
      didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
      releaseMetrics()
      await presetDone
      await flushViewportOps()

      // Without a shared chain + shared URL source, the preset resumes, reads getURL() as the
      // pre-navigation host, and pins the tab to the Chrome-shaped UA while it is on the auth host.
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({
        userAgent: googleAuthUserAgent()
      })
    })

    it('does not leave the Firefox UA standing when a preset lands mid-navigation off an auth host', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4252, 'https://accounts.google.com/')
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-race-off-auth',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      // Establish a standing preset while the tab really is on the auth host.
      await browserManager.setViewportOverride('tab-race-off-auth', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await flushViewportOps()
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({
        userAgent: googleAuthUserAgent()
      })

      // A second preset change is now in flight when the tab leaves the auth host.
      let releaseMetrics = (): void => {}
      const metricsGate = new Promise<void>((resolve) => {
        releaseMetrics = () => resolve()
      })
      debuggerSendCommand.mockImplementation((method: string) =>
        method === 'Emulation.setDeviceMetricsOverride' ? metricsGate : Promise.resolve(undefined)
      )
      const presetDone = browserManager.setViewportOverride('tab-race-off-auth', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 2,
        mobile: false
      })
      await flushViewportOps()

      didStartNavigation(null, 'https://example.com/', false, true)
      releaseMetrics()
      await presetDone
      await flushViewportOps()

      // Without the fix the resuming preset re-reads getURL() as the auth host and clobbers the
      // navigation's correct write, stranding the Firefox UA on a non-auth page.
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({ userAgent: GUEST_CLEAN_UA })
    })

    it('falls back to the committed URL once a navigation commits or fails', async () => {
      const { guest, debuggerSendCommand, commitNavigationTo } = makeGuest(
        4253,
        'https://example.com/'
      )
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-pending-cleared',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
      const didFailLoad = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-fail-load'
      )?.[1] as (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ) => void
      const didNavigate = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-navigate'
      )?.[1] as (event: unknown, url: string) => void

      await browserManager.setViewportOverride('tab-pending-cleared', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await flushViewportOps()

      // An aborted navigation to the auth host must not leave that host standing as the tab's
      // identity: the tab never went there, so a later preset must resolve the committed URL.
      didStartNavigation(null, 'https://accounts.google.com/', false, true)
      didFailLoad(null, -3, 'Aborted', 'https://accounts.google.com/', true)
      await flushViewportOps()

      expect(guest.setUserAgent).toHaveBeenLastCalledWith(GUEST_ELECTRON_UA)
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({ userAgent: GUEST_CLEAN_UA })

      // A later preset must also resolve the committed, non-auth URL.
      debuggerSendCommand.mockClear()
      await browserManager.setViewportOverride('tab-pending-cleared', {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        mobile: true
      })
      await flushViewportOps()
      expect(lastUserAgentOverride(debuggerSendCommand)?.userAgent).toContain('iPhone')

      // Same after a successful commit: the committed URL takes over from the pending target.
      didStartNavigation(null, 'https://accounts.google.com/signin', false, true)
      commitNavigationTo('https://accounts.google.com/signin')
      didNavigate(null, 'https://accounts.google.com/signin')
      await flushViewportOps()

      debuggerSendCommand.mockClear()
      await browserManager.setViewportOverride('tab-pending-cleared', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await flushViewportOps()
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({
        userAgent: googleAuthUserAgent()
      })
    })

    it('does not let a superseded navigation failure revert a newer target', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4255, 'https://example.com/')
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-overlapping-navs',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
      const willRedirect = guestOnMock.mock.calls.find(
        ([event]) => event === 'will-redirect'
      )?.[1] as (
        event: { preventDefault: () => void },
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean
      ) => void
      const didFailLoad = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-fail-load'
      )?.[1] as (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ) => void

      await browserManager.setViewportOverride('tab-overlapping-navs', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      didStartNavigation(null, 'https://example.com/start', false, true)
      willRedirect({ preventDefault: vi.fn() }, 'https://accounts.google.com/same', false, true)
      didStartNavigation(null, 'https://accounts.google.com/same', false, true)
      await flushViewportOps()

      debuggerSendCommand.mockClear()
      didFailLoad(null, -3, 'Aborted', 'https://accounts.google.com/same', true)
      await flushViewportOps()

      expect(guest.setUserAgent).toHaveBeenLastCalledWith(googleAuthUserAgent())
      expect(debuggerSendCommand).not.toHaveBeenCalledWith(
        'Emulation.setUserAgentOverride',
        expect.objectContaining({ userAgent: GUEST_CLEAN_UA })
      )
    })

    it('switches identity for a server redirect and restores it if the redirect fails', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4256, 'https://example.com/')
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-auth-redirect',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
      const willRedirect = guestOnMock.mock.calls.find(
        ([event]) => event === 'will-redirect'
      )?.[1] as (
        event: { preventDefault: () => void },
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean
      ) => void
      const didFailLoad = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-fail-load'
      )?.[1] as (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ) => void

      await browserManager.setViewportOverride('tab-auth-redirect', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      didStartNavigation(null, 'https://example.com/start', false, true)
      willRedirect(
        { preventDefault: vi.fn() },
        'https://accounts.google.com/redirected',
        false,
        true
      )
      await flushViewportOps()

      expect(guest.setUserAgent).toHaveBeenLastCalledWith(googleAuthUserAgent())
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({
        userAgent: googleAuthUserAgent()
      })

      didFailLoad(null, -3, 'Aborted', 'https://accounts.google.com/redirected', true)
      await flushViewportOps()
      expect(guest.setUserAgent).toHaveBeenLastCalledWith(GUEST_ELECTRON_UA)
      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({ userAgent: GUEST_CLEAN_UA })
    })

    it('reapplies a preset when navigation starts during its final UA write', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4257, 'https://example.com/')
      let releaseFirstUa = (): void => {}
      const firstUaGate = new Promise<void>((resolve) => {
        releaseFirstUa = resolve
      })
      let uaWrites = 0
      debuggerSendCommand.mockImplementation((method: string) => {
        if (method === 'Emulation.setUserAgentOverride' && uaWrites++ === 0) {
          return firstUaGate
        }
        return Promise.resolve(undefined)
      })
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-final-apply-race',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      const presetDone = browserManager.setViewportOverride('tab-final-apply-race', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await flushViewportOps()
      didStartNavigation(null, 'https://accounts.google.com/', false, true)
      await flushViewportOps()

      expect(lastUserAgentOverride(debuggerSendCommand)).toEqual({
        userAgent: googleAuthUserAgent()
      })
      releaseFirstUa()
      await presetDone
    })

    it('does not reinstall a preset while its final UA clear is in flight', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4258, 'https://example.com/')
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-final-clear-race',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      await browserManager.setViewportOverride('tab-final-clear-race', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      let releaseClearUa = (): void => {}
      const clearUaGate = new Promise<void>((resolve) => {
        releaseClearUa = resolve
      })
      debuggerSendCommand.mockImplementation(
        (method: string, params: { userAgent?: string } | undefined) =>
          method === 'Emulation.setUserAgentOverride' && params?.userAgent === ''
            ? clearUaGate
            : Promise.resolve(undefined)
      )
      const clearDone = browserManager.setViewportOverride('tab-final-clear-race', null)
      await flushViewportOps()

      debuggerSendCommand.mockClear()
      didStartNavigation(null, 'https://accounts.google.com/', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).not.toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
        userAgent: googleAuthUserAgent()
      })

      releaseClearUa()
      await clearDone
    })

    // Why: a failed clear leaves the CDP override standing on the target. Dropping the tracking entry
    // first makes it untracked, so the navigation path can never correct it again and the tab carries
    // a Chrome-shaped navigator.userAgent onto the auth hosts — the exact failure this PR prevents.
    it('keeps tracking the standing override when the CDP clear fails', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4254, 'https://example.com/')
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-failed-clear',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      await browserManager.setViewportOverride('tab-failed-clear', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await flushViewportOps()

      // The final UA clear fails after tracking was optimistically removed.
      debuggerSendCommand.mockImplementation(
        (method: string, params: { userAgent?: string } | undefined) =>
          method === 'Emulation.setUserAgentOverride' && params?.userAgent === ''
            ? Promise.reject(new Error('debugger detached'))
            : Promise.resolve(undefined)
      )
      await expect(browserManager.setViewportOverride('tab-failed-clear', null)).resolves.toBe(
        false
      )
      await flushViewportOps()

      // The override is still standing on the target, so navigation must still be able to correct it.
      debuggerSendCommand.mockImplementation(() => Promise.resolve(undefined))
      debuggerSendCommand.mockClear()
      didStartNavigation(null, 'https://accounts.google.com/v3/signin/identifier', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
        userAgent: googleAuthUserAgent()
      })
    })

    it('does not touch the UA override on navigation when no preset is standing', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4248)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-no-preset',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      didStartNavigation(null, 'https://accounts.google.com/', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).not.toHaveBeenCalledWith(
        'Emulation.setUserAgentOverride',
        expect.anything()
      )
    })

    it('stops re-issuing the UA override once the preset is cleared', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4249)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-cleared-preset',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      await browserManager.setViewportOverride('tab-cleared-preset', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      await browserManager.setViewportOverride('tab-cleared-preset', null)

      debuggerSendCommand.mockClear()
      didStartNavigation(null, 'https://accounts.google.com/', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).not.toHaveBeenCalledWith(
        'Emulation.setUserAgentOverride',
        expect.anything()
      )
    })

    it('leaves the UA override alone on navigation for native-UA profiles', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4250)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-native-nav',
        sessionProfileId: 'native-profile',
        userAgentMode: 'native',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })
      const didStartNavigation = guestOnMock.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void

      await browserManager.setViewportOverride('tab-native-nav', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })
      debuggerSendCommand.mockClear()
      didStartNavigation(null, 'https://accounts.google.com/', false, true)
      await flushViewportOps()
      expect(debuggerSendCommand).not.toHaveBeenCalledWith(
        'Emulation.setUserAgentOverride',
        expect.anything()
      )
    })

    it('clears device metrics and disables touch for override=null', async () => {
      const { guest, debuggerSendCommand } = makeGuest(4343)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-clear',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })

      const ok = await browserManager.setViewportOverride('tab-clear', null)
      expect(ok).toBe(true)

      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride', {})
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', {
        enabled: false,
        maxTouchPoints: 0
      })
      expect(debuggerSendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
        userAgent: ''
      })
    })

    it('attaches the debugger if not already attached and does not detach after', async () => {
      const { guest, debuggerSendCommand, debuggerAttach } = makeGuest(4444)
      ;(guest.debugger as { isAttached: ReturnType<typeof vi.fn> }).isAttached = vi.fn(() => false)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-attach',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })

      await browserManager.setViewportOverride('tab-attach', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })

      expect(debuggerAttach).toHaveBeenCalledWith('1.3')
      expect(debuggerSendCommand).toHaveBeenCalled()
      // Why: detaching would clear Page.addScriptToEvaluateOnNewDocument
      // (anti-detection). Guard regression.
      expect((guest.debugger as { detach?: unknown }).detach ?? undefined).toBeUndefined()
    })

    it('returns false when debugger.attach throws (e.g. DevTools already open)', async () => {
      const { guest, debuggerSendCommand, debuggerAttach } = makeGuest(4545)
      ;(guest.debugger as { isAttached: ReturnType<typeof vi.fn> }).isAttached = vi.fn(() => false)
      // Why: Electron throws from debugger.attach if another client (e.g. the
      // user's open DevTools window) is already attached. setViewportOverride
      // must surface this as a clean `false` rather than an unhandled rejection.
      debuggerAttach.mockImplementation(() => {
        throw new Error('Another debugger is already attached')
      })
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-attach-throws',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })

      const ok = await browserManager.setViewportOverride('tab-attach-throws', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false
      })

      expect(ok).toBe(false)
      expect(debuggerAttach).toHaveBeenCalledWith('1.3')
      expect(debuggerSendCommand).not.toHaveBeenCalled()
    })

    it('installs annotation viewport bridge in an isolated world', async () => {
      const { guest } = makeGuest(4646)
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: 'tab-annotations',
        webContentsId: guest.id as number,
        rendererWebContentsId
      })

      const ok = await browserManager.setAnnotationViewportBridge('tab-annotations', {
        emitViewport: false,
        enabled: true,
        markers: [],
        token: 'annotationviewporttoken'
      })

      expect(ok).toBe(true)
      expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
        expect.any(Number),
        [
          expect.objectContaining({
            code: expect.stringContaining('__orcaBrowserAnnotationViewportBridge')
          })
        ],
        false
      )
    })
  })
})
