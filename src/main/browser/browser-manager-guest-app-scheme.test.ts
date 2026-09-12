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
  openPopupWithOriginBarMock: vi.fn(),
  openExternalAppUrlWithUserApprovalMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: browserMocks.appGetPathMock
  },
  BrowserWindow: {
    fromWebContents: browserMocks.browserWindowFromWebContentsMock
  },
  clipboard: { writeText: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
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

vi.mock('../external-app-url-open', () => ({
  openExternalAppUrlWithUserApproval: browserMocks.openExternalAppUrlWithUserApprovalMock
}))

import { browserManager } from './browser-manager'
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
  openExternalAppUrlWithUserApprovalMock
} = browserMocks

function registerAppSchemeGuest(input: {
  id: number
  browserPageId: string
  executeJavaScriptInIsolatedWorld?: ReturnType<typeof vi.fn>
  rendererSend: ReturnType<typeof vi.fn>
}): {
  guest: {
    id: number
    isDestroyed: ReturnType<typeof vi.fn>
    getType: ReturnType<typeof vi.fn>
    getURL: ReturnType<typeof vi.fn>
    setBackgroundThrottling: typeof guestSetBackgroundThrottlingMock
    setWindowOpenHandler: typeof guestSetWindowOpenHandlerMock
    on: typeof guestOnMock
    off: typeof guestOffMock
    openDevTools: typeof guestOpenDevToolsMock
    executeJavaScriptInIsolatedWorld?: ReturnType<typeof vi.fn>
  }
} {
  const guest = {
    id: input.id,
    isDestroyed: vi.fn(() => false),
    getType: vi.fn(() => 'webview'),
    getURL: vi.fn(() => 'https://login.example.com/sso'),
    mainFrame: {
      url: 'https://login.example.com/sso',
      isDestroyed: vi.fn(() => false)
    },
    setBackgroundThrottling: guestSetBackgroundThrottlingMock,
    setWindowOpenHandler: guestSetWindowOpenHandlerMock,
    on: guestOnMock,
    off: guestOffMock,
    openDevTools: guestOpenDevToolsMock,
    ...(input.executeJavaScriptInIsolatedWorld
      ? { executeJavaScriptInIsolatedWorld: input.executeJavaScriptInIsolatedWorld }
      : {})
  }
  webContentsFromIdMock.mockImplementation((id: number) => {
    if (id === guest.id) {
      return guest
    }
    if (id === rendererWebContentsId) {
      return { isDestroyed: vi.fn(() => false), send: input.rendererSend }
    }
    return null
  })
  browserManager.attachGuestPolicies(guest as never)
  browserManager.registerGuest({
    browserPageId: input.browserPageId,
    webContentsId: guest.id,
    rendererWebContentsId
  })
  return { guest }
}

describe('browserManager custom app schemes', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
    openExternalAppUrlWithUserApprovalMock.mockReset()
    openExternalAppUrlWithUserApprovalMock.mockResolvedValue('opened')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('attributes main-frame navigation to the actual initiating iframe', async () => {
    registerAppSchemeGuest({
      id: 119,
      browserPageId: 'iframe-app-scheme-review',
      rendererSend: vi.fn()
    })
    const handler = guestOnMock.mock.calls.find(([event]) => event === 'will-navigate')?.[1]
    const event = {
      preventDefault: vi.fn(),
      isMainFrame: true,
      frame: { url: 'https://login.example.com/sso' },
      initiator: { url: 'https://untrusted-frame.example/embedded' }
    }
    handler(event, 'oktaverify://bind?token=iframe')
    await vi.waitFor(() => {
      expect(openExternalAppUrlWithUserApprovalMock).toHaveBeenCalledWith(
        'oktaverify://bind?token=iframe',
        expect.objectContaining({ requestingOrigin: 'https://untrusted-frame.example' })
      )
    })
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('attributes will-redirect to the initiating frame, not the destination', async () => {
    registerAppSchemeGuest({
      id: 120,
      browserPageId: 'iframe-app-scheme-redirect',
      rendererSend: vi.fn()
    })
    const handler = guestOnMock.mock.calls.find(([event]) => event === 'will-redirect')?.[1]
    const event = {
      preventDefault: vi.fn(),
      isMainFrame: true,
      frame: { url: 'https://login.example.com/sso' },
      initiator: { url: 'https://untrusted-frame.example/redirector' }
    }
    handler(event, 'oktaverify://bind?token=redirect', false, true)
    await vi.waitFor(() => {
      expect(openExternalAppUrlWithUserApprovalMock).toHaveBeenCalledWith(
        'oktaverify://bind?token=redirect',
        expect.objectContaining({ requestingOrigin: 'https://untrusted-frame.example' })
      )
    })
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('uses unknown when navigation initiator is missing rather than the top page', async () => {
    registerAppSchemeGuest({
      id: 121,
      browserPageId: 'iframe-app-scheme-unknown',
      rendererSend: vi.fn()
    })
    const handler = guestOnMock.mock.calls.find(([event]) => event === 'will-navigate')?.[1]
    const event = {
      preventDefault: vi.fn(),
      isMainFrame: true,
      frame: { url: 'https://login.example.com/sso' }
    }
    handler(event, 'oktaverify://bind?token=no-initiator')
    await vi.waitFor(() => {
      expect(openExternalAppUrlWithUserApprovalMock).toHaveBeenCalledWith(
        'oktaverify://bind?token=no-initiator',
        expect.objectContaining({ requestingOrigin: 'unknown' })
      )
    })
  })

  it('prompts and opens custom app schemes from popup and will-navigate paths', async () => {
    const rendererSendMock = vi.fn()
    registerAppSchemeGuest({
      id: 107,
      browserPageId: 'browser-app-scheme',
      rendererSend: rendererSendMock
    })

    const handler = guestSetWindowOpenHandlerMock.mock.calls.at(-1)?.[0] as (details: {
      url: string
    }) => { action: 'allow' | 'deny' }
    expect(handler({ url: 'oktaverify://bind?token=1' })).toEqual({ action: 'deny' })
    await vi.waitFor(() => {
      expect(openExternalAppUrlWithUserApprovalMock).toHaveBeenCalledWith(
        'oktaverify://bind?token=1',
        expect.objectContaining({ requestingOrigin: 'unknown' })
      )
    })
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-app-scheme',
      origin: 'null',
      action: 'opened-external'
    })

    openExternalAppUrlWithUserApprovalMock.mockClear()
    rendererSendMock.mockClear()
    openExternalAppUrlWithUserApprovalMock.mockResolvedValue('cancelled')
    const willNavigateHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'will-navigate'
    )?.[1] as ((event: { preventDefault: () => void }, url: string) => void) | undefined
    const preventDefault = vi.fn()
    willNavigateHandler?.({ preventDefault }, 'oktaverify://bind?token=2')
    expect(preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(openExternalAppUrlWithUserApprovalMock).toHaveBeenCalledWith(
        'oktaverify://bind?token=2',
        expect.objectContaining({ requestingOrigin: 'unknown' })
      )
    })
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-app-scheme',
      origin: 'null',
      action: 'blocked'
    })
  })

  it('prompts custom app schemes on the clicked-link window-open path', async () => {
    const rendererSendMock = vi.fn()
    const executeJavaScriptInIsolatedWorldMock = vi.fn().mockResolvedValue(undefined)
    registerAppSchemeGuest({
      id: 108,
      browserPageId: 'browser-clicked-app-scheme',
      executeJavaScriptInIsolatedWorld: executeJavaScriptInIsolatedWorldMock,
      rendererSend: rendererSendMock
    })

    const domReadyHandler = guestOnMock.mock.calls.find(([event]) => event === 'dom-ready')?.[1] as
      | (() => void)
      | undefined
    domReadyHandler?.()
    await vi.waitFor(() => expect(executeJavaScriptInIsolatedWorldMock).toHaveBeenCalledTimes(1))

    const script = executeJavaScriptInIsolatedWorldMock.mock.calls[0][1][0].code as string
    const clickedLinkFrameName = script.match(/__orca_clicked_link_foreground_[0-9a-f-]+/)?.[0]
    if (!clickedLinkFrameName) {
      throw new Error('Expected a private clicked-link frame name')
    }

    const handler = guestSetWindowOpenHandlerMock.mock.calls.at(-1)?.[0] as (details: {
      url: string
      frameName: string
    }) => { action: 'allow' | 'deny' }
    expect(
      handler({
        url: 'oktaverify://bind?from=clicked-link',
        frameName: clickedLinkFrameName
      })
    ).toEqual({ action: 'deny' })

    await vi.waitFor(() => {
      expect(openExternalAppUrlWithUserApprovalMock).toHaveBeenCalledWith(
        'oktaverify://bind?from=clicked-link',
        expect.objectContaining({ requestingOrigin: 'https://login.example.com' })
      )
    })
    expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
      browserPageId: 'browser-clicked-app-scheme',
      origin: 'null',
      action: 'opened-external'
    })
    expect(rendererSendMock).not.toHaveBeenCalledWith(
      'browser:open-link-in-orca-tab',
      expect.anything()
    )
  })

  it('keeps http(s) and later file: navigations off the custom-scheme prompt', () => {
    const rendererSendMock = vi.fn()
    registerAppSchemeGuest({
      id: 109,
      browserPageId: 'browser-app-scheme-http-file',
      rendererSend: rendererSendMock
    })
    const willNavigateHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'will-navigate'
    )?.[1] as ((event: { preventDefault: () => void }, url: string) => void) | undefined
    const httpPreventDefault = vi.fn()
    willNavigateHandler?.({ preventDefault: httpPreventDefault }, 'https://example.com/next')
    expect(httpPreventDefault).not.toHaveBeenCalled()

    const filePreventDefault = vi.fn()
    willNavigateHandler?.({ preventDefault: filePreventDefault }, 'file:///etc/passwd')
    expect(filePreventDefault).toHaveBeenCalled()

    const javascriptPreventDefault = vi.fn()
    willNavigateHandler?.({ preventDefault: javascriptPreventDefault }, 'javascript:alert(1)')
    expect(javascriptPreventDefault).toHaveBeenCalled()

    const devtoolsPreventDefault = vi.fn()
    willNavigateHandler?.(
      { preventDefault: devtoolsPreventDefault },
      'devtools://devtools/bundled/inspector.html'
    )
    expect(devtoolsPreventDefault).toHaveBeenCalled()

    expect(openExternalAppUrlWithUserApprovalMock).not.toHaveBeenCalled()
  })

  it('blocks extra custom-scheme prompts while one is already pending for the guest', async () => {
    let releaseFirst!: (value: 'opened') => void
    openExternalAppUrlWithUserApprovalMock.mockImplementationOnce(
      () =>
        new Promise<'opened'>((resolve) => {
          releaseFirst = resolve
        })
    )
    const rendererSendMock = vi.fn()
    registerAppSchemeGuest({
      id: 131,
      browserPageId: 'browser-app-scheme-inflight',
      rendererSend: rendererSendMock
    })
    const handler = guestSetWindowOpenHandlerMock.mock.calls.at(-1)?.[0] as (details: {
      url: string
    }) => { action: 'allow' | 'deny' }
    expect(handler({ url: 'oktaverify://one' })).toEqual({ action: 'deny' })
    await vi.waitFor(() => {
      expect(openExternalAppUrlWithUserApprovalMock).toHaveBeenCalledTimes(1)
    })
    expect(handler({ url: 'oktaverify://two' })).toEqual({ action: 'deny' })
    await vi.waitFor(() => {
      expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
        browserPageId: 'browser-app-scheme-inflight',
        origin: 'null',
        action: 'blocked'
      })
    })
    expect(openExternalAppUrlWithUserApprovalMock).toHaveBeenCalledTimes(1)
    releaseFirst('opened')
    await vi.waitFor(() => {
      expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
        browserPageId: 'browser-app-scheme-inflight',
        origin: 'null',
        action: 'opened-external'
      })
    })
  })

  it('denies native child windows and does not prompt for denied popup schemes', () => {
    const rendererSendMock = vi.fn()
    registerAppSchemeGuest({
      id: 110,
      browserPageId: 'browser-app-scheme-denied-popup',
      rendererSend: rendererSendMock
    })
    const handler = guestSetWindowOpenHandlerMock.mock.calls.at(-1)?.[0] as (details: {
      url: string
    }) => { action: 'allow' | 'deny'; createWindow?: unknown }
    expect(handler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    const custom = handler({ url: 'oktaverify://bind' })
    expect(custom).toEqual({ action: 'deny' })
    expect(custom.createWindow).toBeUndefined()
    expect(openExternalAppUrlWithUserApprovalMock).toHaveBeenCalledTimes(1)
    expect(openExternalAppUrlWithUserApprovalMock).toHaveBeenCalledWith(
      'oktaverify://bind',
      expect.objectContaining({ requestingOrigin: 'unknown' })
    )
  })

  it('attributes known iframe clicked-link custom schemes to the iframe origin', async () => {
    const rendererSendMock = vi.fn()
    const executeJavaScriptMock = vi.fn().mockResolvedValue(undefined)
    const frameOnceMock = vi.fn()
    const frame = {
      parent: {},
      url: 'https://untrusted-frame.example/embedded',
      isDestroyed: vi.fn(() => false),
      executeJavaScript: executeJavaScriptMock,
      once: frameOnceMock,
      off: vi.fn()
    }
    registerAppSchemeGuest({
      id: 122,
      browserPageId: 'iframe-clicked-app-scheme',
      executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue(undefined),
      rendererSend: rendererSendMock
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
    const iframeFrameName = (executeJavaScriptMock.mock.calls[0][0] as string).match(
      /__orca_clicked_link_iframe_foreground_[0-9a-f-]+/
    )?.[0]
    if (!iframeFrameName) {
      throw new Error('Expected a private iframe clicked-link frame name')
    }
    const handler = guestSetWindowOpenHandlerMock.mock.calls.at(-1)?.[0] as (details: {
      url: string
      frameName: string
    }) => { action: 'allow' | 'deny' }
    expect(
      handler({
        url: 'oktaverify://bind?from=iframe-click',
        frameName: iframeFrameName
      })
    ).toEqual({ action: 'deny' })
    await vi.waitFor(() => {
      expect(openExternalAppUrlWithUserApprovalMock).toHaveBeenCalledWith(
        'oktaverify://bind?from=iframe-click',
        expect.objectContaining({ requestingOrigin: 'https://untrusted-frame.example' })
      )
    })
  })
})
