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

vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from './browser-manager'
import {
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'
import { installDocPreviewGuestPolicy } from './doc-preview-guest-policy'
import { mintDocPreviewGrant, revokeAllDocPreviewGrants } from './doc-preview-grant-registry'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'

/** Register a real document page; membership checks do not rely on ID shape. */
function registerWorkspaceDocPage(browserPageId: string): void {
  const grant = mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html',
    browserPageId
  })
  const guest = {
    isFocused: () => false,
    isDestroyed: () => false,
    getURL: () => buildDocPreviewUrl(grant.id, grant.entryRelativePath),
    on: vi.fn(),
    once: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn()
  }
  installDocPreviewGuestPolicy(guest as never, { id: rendererWebContentsId, send: vi.fn() })
}

const {
  guestOffMock,
  guestOnMock,
  guestSetBackgroundThrottlingMock,
  guestSetWindowOpenHandlerMock,
  guestOpenDevToolsMock,
  browserWindowFromWebContentsMock,
  webContentsFromIdMock,
  menuBuildFromTemplateMock
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

  it('remembers the registered session profile for a browser page', () => {
    const guest = {
      id: 104,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
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

  it.each(['registerGuest', 'registerOffscreenGuest'] as const)(
    'refuses %s for a page the document registry already holds',
    (entryPoint) => {
      const guest = {
        id: 129,
        isDestroyed: vi.fn(() => false),
        getType: vi.fn(() => 'webview'),
        isCurrentlyAudible: vi.fn(() => false),
        send: vi.fn(),
        setBackgroundThrottling: guestSetBackgroundThrottlingMock,
        setWindowOpenHandler: guestSetWindowOpenHandlerMock,
        on: guestOnMock,
        off: guestOffMock,
        openDevTools: guestOpenDevToolsMock
      }
      webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      const browserPageId = 'doc-page-1'
      registerWorkspaceDocPage(browserPageId)

      if (entryPoint === 'registerGuest') {
        expect(
          browserManager.registerGuest({
            browserPageId,
            webContentsId: guest.id,
            rendererWebContentsId
          })
        ).toBe(false)
      } else {
        expect(
          browserManager.registerOffscreenGuest({ browserPageId, webContentsId: guest.id })
        ).toBe(false)
      }

      expect(browserManager.getGuestWebContentsId(browserPageId)).toBeNull()
    }
  )

  // The headless backend destroys its window when registration returns false.
  it.each(['missing', 'destroyed'] as const)(
    'refuses registerOffscreenGuest when the named guest is %s',
    (guestState) => {
      webContentsFromIdMock.mockReturnValue(
        guestState === 'missing' ? null : { id: 137, isDestroyed: vi.fn(() => true) }
      )

      expect(
        browserManager.registerOffscreenGuest({ browserPageId: 'offscreen-1', webContentsId: 137 })
      ).toBe(false)

      expect(browserManager.getGuestWebContentsId('offscreen-1')).toBeNull()
    }
  )

  it('refuses devtools for an offscreen guest instead of opening it on the host display', async () => {
    const guest = {
      id: 138,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'window'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockReturnValue(guest)
    expect(
      browserManager.registerOffscreenGuest({
        browserPageId: 'offscreen-devtools',
        webContentsId: guest.id
      })
    ).toBe(true)

    await expect(browserManager.openDevTools('offscreen-devtools')).resolves.toBe(false)
    expect(guestOpenDevToolsMock).not.toHaveBeenCalled()
  })

  it('docks devtools into the page pane, or pops them out to a window when asked', async () => {
    const setDevToolsWebContents = vi.fn()
    const guest = {
      id: 139,
      hostWebContents: {},
      isDestroyed: vi.fn(() => false),
      isDevToolsOpened: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      setDevToolsWebContents,
      on: guestOnMock,
      once: vi.fn(),
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const renderer = { id: rendererWebContentsId, isDestroyed: () => false, send: vi.fn() }
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === rendererWebContentsId ? renderer : guest
    )
    browserWindowFromWebContentsMock.mockReturnValue({
      isDestroyed: () => false,
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
    })
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'desktop-devtools',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    await expect(browserManager.openDevTools('desktop-devtools')).resolves.toBe(true)
    expect(setDevToolsWebContents).toHaveBeenCalledWith(expect.objectContaining({ id: 9001 }))
    expect(guestOpenDevToolsMock).not.toHaveBeenCalledWith({ mode: 'detach' })
    expect(renderer.send).toHaveBeenLastCalledWith('browser:devToolsDockChanged', {
      browserPageId: 'desktop-devtools',
      docked: true
    })

    await browserManager.openDevTools('desktop-devtools', undefined, { detach: true })
    expect(guestOpenDevToolsMock).toHaveBeenLastCalledWith({ mode: 'detach' })
    expect(renderer.send).toHaveBeenLastCalledWith('browser:devToolsDockChanged', {
      browserPageId: 'desktop-devtools',
      docked: false
    })
  })

  it('refuses unregisterGuest for a page the document registry holds', () => {
    registerWorkspaceDocPage('doc-page-2')
    const cancelGrabOp = vi.spyOn(browserManager, 'cancelGrabOp')

    browserManager.unregisterGuest('doc-page-2')

    expect(cancelGrabOp).not.toHaveBeenCalled()

    browserManager.unregisterGuest('browser-page-1')
    expect(cancelGrabOp).toHaveBeenCalledWith('browser-page-1', 'evicted')
    cancelGrabOp.mockRestore()
  })

  it('blocks non-web guest navigations after attach', () => {
    const guest = {
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
      getURL: vi.fn(() => 'https://example.com/'),
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

  it.each([
    ['https://example.com/', true],
    ['file:///docs/plan.html', false]
  ])('from %s, a file: link navigation is blocked=%s', (currentUrl, blocked) => {
    const guest = {
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
      getURL: vi.fn(() => currentUrl),
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
    const preventDefault = vi.fn()
    willNavigateHandler?.({ preventDefault }, 'file:///docs/index.html')
    expect(preventDefault).toHaveBeenCalledTimes(blocked ? 1 : 0)
  })

  it('unregisterAll clears tracked guests and context-menu listeners', () => {
    const guest = {
      id: 101,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
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
      rendererWebContentsId
    })
    browserManager.attachGuestPolicies({ ...guest, id: 102 } as never)
    browserManager.registerGuest({
      browserPageId: 'browser-2',
      webContentsId: 102,
      rendererWebContentsId
    })
    // Policies attached before registration also need cleanup.
    const unregisteredGuestOff = vi.fn()
    browserManager.attachGuestPolicies({ ...guest, id: 103, off: unregisteredGuestOff } as never)

    browserManager.unregisterAll()

    expect(browserManager.getGuestWebContentsId('browser-1')).toBeNull()
    expect(browserManager.getGuestWebContentsId('browser-2')).toBeNull()
    expect(guestOffMock).toHaveBeenCalled()
    expect(unregisteredGuestOff).toHaveBeenCalledWith('did-create-window', expect.any(Function))
    expect(unregisteredGuestOff).toHaveBeenCalledWith('input-event', expect.any(Function))
  })

  it('rejects non-webview guest types to prevent privilege escalation', () => {
    // An untrusted renderer could submit the main window WebContents ID.
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

    expect(browserManager.getGuestWebContentsId('browser-evil')).toBeNull()
    expect(guestSetWindowOpenHandlerMock).not.toHaveBeenCalled()
  })

  it('rejects registration for guests that never received attach-time policy wiring', () => {
    const guest = {
      id: 777,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
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
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
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

  it('cleans attached guest policy state when a guest is destroyed before registration', () => {
    const guest = {
      id: 304,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
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
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
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
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
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

  it('cleans up prior guest listeners before re-registering the same tab', () => {
    const guest = {
      id: 808,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
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

  // Browsing guests track override invalidation without attaching a debugger.
  it('never attaches a debugger to a browsing guest and drops its detach listener on unregister', () => {
    const debuggerHandlers = new Map<string, () => void>()
    const debuggerAttachMock = vi.fn()
    const guest = {
      id: 809,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      isCurrentlyAudible: vi.fn(() => false),
      send: vi.fn(),
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
      browserPageId: 'browser-no-debugger',
      webContentsId: 809,
      rendererWebContentsId
    })

    expect(debuggerAttachMock).not.toHaveBeenCalled()
    expect(guest.debugger.sendCommand).not.toHaveBeenCalled()
    expect(debuggerHandlers.has('detach')).toBe(true)

    browserManager.unregisterGuest('browser-no-debugger')
    expect(debuggerHandlers.has('detach')).toBe(false)
    expect(debuggerAttachMock).not.toHaveBeenCalled()
  })

  // The renderer re-applies a tab's mute on each registration report and clears the
  // speaker on the unregister report, so neither may be skipped.
  it('reports page audio on registration and on change, and silence on unregister', () => {
    const rendererSend = vi.fn()
    const guest = {
      id: 301,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      isCurrentlyAudible: vi.fn(() => true),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === guest.id
        ? guest
        : id === rendererWebContentsId
          ? { isDestroyed: () => false, send: rendererSend }
          : null
    )
    browserManager.attachGuestPolicies(guest as never)
    const onAudioStateChanged: (event: { audible: boolean }) => void = guestOnMock.mock.calls.find(
      ([event]) => event === 'audio-state-changed'
    )?.[1]

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
