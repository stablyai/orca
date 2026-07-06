/* oxlint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
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
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 }))
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

import { browserManager } from './browser-manager'

describe('browserManager', () => {
  const rendererWebContentsId = 5001
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
    browserManager.unregisterAll()
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

  it('routes safe popup URLs into a new Orca browser tab for the owning renderer', () => {
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
    }) => { action: 'deny' }
    expect(handler({ url: 'https://example.com/login' })).toEqual({ action: 'deny' })

    expect(shellOpenExternalMock).not.toHaveBeenCalled()
    expect(rendererSendMock).toHaveBeenCalledWith('browser:open-link-in-orca-tab', {
      browserPageId: 'browser-1',
      url: 'https://example.com/login'
    })
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-1',
      origin: 'https://example.com',
      action: 'opened-in-orca'
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

    browserManager.unregisterAll()

    expect(browserManager.getGuestWebContentsId('browser-1')).toBeNull()
    expect(browserManager.getGuestWebContentsId('browser-2')).toBeNull()
    expect(guestOffMock).toHaveBeenCalled()
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
      getURL: vi.fn(() => 'http://localhost:3000/')
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
        savePath: '/downloads/report.csv',
        status: 'downloading'
      })
    )
    expect(item.setSavePath).toHaveBeenCalledWith('/downloads/report.csv')
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

    expect(item.setSavePath).toHaveBeenCalledWith('/downloads/report.csv')
    expect(item.on).toHaveBeenCalledWith('updated', expect.any(Function))
    expect(item.once).toHaveBeenCalledWith('done', expect.any(Function))
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-requested',
      expect.objectContaining({
        browserPageId: 'browser-1',
        filename: 'report.csv',
        savePath: '/downloads/report.csv',
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
        savePath: '/downloads/report.csv',
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
    expect(rendererSendMock).toHaveBeenNthCalledWith(4, 'ui:switchTab', 1)
    expect(rendererSendMock).toHaveBeenNthCalledWith(5, 'ui:switchTerminalTab', 1)
    expect(rendererSendMock).toHaveBeenNthCalledWith(6, 'ui:openQuickOpen')
    expect(rendererSendMock).toHaveBeenNthCalledWith(7, 'ui:focusBrowserAddressBar')
    expect(rendererSendMock).toHaveBeenNthCalledWith(8, 'ui:reloadBrowserPage')
    expect(rendererSendMock).toHaveBeenNthCalledWith(9, 'ui:hardReloadBrowserPage')
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

    expect(keyDownPreventDefault).toHaveBeenCalledTimes(1)
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
    function makeGuest(id: number): {
      guest: Record<string, unknown>
      debuggerSendCommand: ReturnType<typeof vi.fn>
      debuggerIsAttached: ReturnType<typeof vi.fn>
      debuggerAttach: ReturnType<typeof vi.fn>
    } {
      const debuggerSendCommand = vi.fn().mockResolvedValue(undefined)
      const debuggerIsAttached = vi.fn(() => true)
      const debuggerAttach = vi.fn()
      const guest = {
        id,
        isDestroyed: vi.fn(() => false),
        getType: vi.fn(() => 'webview'),
        getUserAgent: vi.fn(
          () =>
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/134.0.0.0 Electron/30.0.0 Safari/537.36'
        ),
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
      return { guest, debuggerSendCommand, debuggerIsAttached, debuggerAttach }
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
