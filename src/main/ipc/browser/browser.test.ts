import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  removeHandlerMock,
  handleMock,
  registerGuestMock,
  attachGuestPoliciesMock,
  unregisterGuestMock,
  getGuestWebContentsIdMock,
  getWebContentsIdByTabIdMock,
  getWorktreeIdForTabMock,
  getAuthorizedGuestMock,
  setGrabModeMock,
  openDevToolsMock,
  setAnnotationViewportBridgeMock,
  cancelDownloadMock,
  proceedCertificateMock,
  browserWindowFromWebContentsMock,
  webContentsFromIdMock
} = vi.hoisted(() => ({
  removeHandlerMock: vi.fn(),
  handleMock: vi.fn(),
  registerGuestMock: vi.fn(),
  attachGuestPoliciesMock: vi.fn(),
  unregisterGuestMock: vi.fn(),
  getGuestWebContentsIdMock: vi.fn(),
  getWebContentsIdByTabIdMock: vi.fn(() => new Map()),
  getWorktreeIdForTabMock: vi.fn(),
  getAuthorizedGuestMock: vi.fn(),
  setGrabModeMock: vi.fn(),
  openDevToolsMock: vi.fn().mockResolvedValue(true),
  setAnnotationViewportBridgeMock: vi.fn().mockResolvedValue(true),
  cancelDownloadMock: vi.fn(),
  proceedCertificateMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  webContentsFromIdMock: vi.fn()
}))

vi.mock('./browser-passwords-ipc', () => ({ registerBrowserPasswordsHandlers: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: browserWindowFromWebContentsMock },
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock
  },
  webContents: {
    fromId: webContentsFromIdMock
  }
}))

vi.mock('../../browser/guest-lifecycle/manager/browser-manager', () => ({
  browserCertificateTrustController: {
    proceed: proceedCertificateMock
  },
  browserManager: {
    registerGuest: registerGuestMock,
    attachGuestPolicies: attachGuestPoliciesMock,
    unregisterGuest: unregisterGuestMock,
    getGuestWebContentsId: getGuestWebContentsIdMock,
    getWebContentsIdByTabId: getWebContentsIdByTabIdMock,
    getWorktreeIdForTab: getWorktreeIdForTabMock,
    getAuthorizedGuest: getAuthorizedGuestMock,
    setGrabMode: setGrabModeMock,
    openDevTools: openDevToolsMock,
    setAnnotationViewportBridge: setAnnotationViewportBridgeMock,
    cancelDownload: cancelDownloadMock
  }
}))
import { registerBrowserHandlers, setAgentBrowserBridgeRef } from './browser'
import { setTrustedBrowserRendererWebContentsId } from './browser-renderer-trust'
import { waitForWorktreeTabRegistration } from './browser-tab-registration-wait'

const trustedSender = {
  id: 91,
  isDestroyed: () => false,
  getType: () => 'window',
  getURL: () => 'file:///renderer/index.html'
} as Electron.WebContents

describe('registerBrowserHandlers', () => {
  beforeEach(() => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    setTrustedBrowserRendererWebContentsId(trustedSender.id)
    removeHandlerMock.mockReset()
    handleMock.mockReset()
    registerGuestMock.mockReset()
    registerGuestMock.mockReturnValue(true)
    attachGuestPoliciesMock.mockReset()
    unregisterGuestMock.mockReset()
    getGuestWebContentsIdMock.mockReset()
    getWebContentsIdByTabIdMock.mockReset()
    getWebContentsIdByTabIdMock.mockReturnValue(new Map())
    getWorktreeIdForTabMock.mockReset()
    getAuthorizedGuestMock.mockReset()
    setGrabModeMock.mockReset()
    setGrabModeMock.mockResolvedValue(true)
    openDevToolsMock.mockReset()
    setAnnotationViewportBridgeMock.mockReset()
    cancelDownloadMock.mockReset()
    proceedCertificateMock.mockReset()
    proceedCertificateMock.mockReturnValue({ ok: true })
    browserWindowFromWebContentsMock.mockReset()
    webContentsFromIdMock.mockReset()
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => false })
    openDevToolsMock.mockResolvedValue(true)
    setAnnotationViewportBridgeMock.mockResolvedValue(true)
    setAgentBrowserBridgeRef(null)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('repairs only a live webview owned by the trusted renderer', () => {
    registerBrowserHandlers({ getSettings: vi.fn() })
    const repairHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:repairGuestRegistration'
    )?.[1] as (
      event: { sender: Electron.WebContents },
      args: {
        browserPageId: string
        workspaceId: string
        worktreeId: string
        webContentsId: number
      }
    ) => boolean
    const guest = {
      id: 123,
      hostWebContents: trustedSender,
      isDestroyed: () => false,
      getType: () => 'webview'
    } as Electron.WebContents
    webContentsFromIdMock.mockReturnValue(guest)
    const args = {
      browserPageId: 'page-1',
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
      webContentsId: 123
    }

    expect(repairHandler({ sender: trustedSender }, args)).toBe(true)
    expect(attachGuestPoliciesMock).toHaveBeenCalledWith(guest)
    expect(registerGuestMock).toHaveBeenCalledWith({
      ...args,
      rendererWebContentsId: trustedSender.id
    })

    webContentsFromIdMock.mockReturnValue({
      ...guest,
      hostWebContents: { id: 92 }
    })
    expect(repairHandler({ sender: trustedSender }, args)).toBe(false)
    expect(registerGuestMock).toHaveBeenCalledTimes(1)
  })

  it('rejects browser download cancellation from untrusted callers', () => {
    registerBrowserHandlers({ getSettings: vi.fn() })

    const cancelHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:cancelDownload'
    )?.[1] as (event: { sender: Electron.WebContents }, args: { downloadId: string }) => boolean

    const result = cancelHandler(
      {
        sender: {
          id: 92,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'https://example.com'
        } as Electron.WebContents
      },
      { downloadId: 'download-1' }
    )

    expect(result).toBe(false)
    expect(cancelDownloadMock).not.toHaveBeenCalled()
  })

  it('allows only the trusted renderer to approve an exact certificate challenge', () => {
    registerBrowserHandlers({ getSettings: vi.fn() })
    const proceedHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:proceedCertificate'
    )?.[1] as (event: { sender: Electron.WebContents }, args: unknown) => unknown

    expect(
      proceedHandler(
        { sender: trustedSender },
        { browserPageId: 'page-1', challengeId: 'challenge-1' }
      )
    ).toEqual({ ok: true })
    expect(proceedCertificateMock).toHaveBeenCalledWith('page-1', 'challenge-1')

    proceedCertificateMock.mockClear()
    const untrustedSender = {
      id: 92,
      isDestroyed: () => false,
      getType: () => 'webview',
      getURL: () => 'https://localhost:3443/'
    } as Electron.WebContents
    expect(
      proceedHandler(
        { sender: untrustedSender },
        { browserPageId: 'page-1', challengeId: 'challenge-1' }
      )
    ).toEqual({ ok: false, reason: 'missing' })

    setTrustedBrowserRendererWebContentsId(null)
    expect(
      proceedHandler(
        { sender: trustedSender },
        { browserPageId: 'page-1', challengeId: 'challenge-1' }
      )
    ).toEqual({ ok: false, reason: 'missing' })
    expect(proceedCertificateMock).not.toHaveBeenCalled()
  })

  it('does not enable grab mode after a pending request is cancelled', async () => {
    const guest = { id: 123 } as Electron.WebContents
    let registered = false
    getAuthorizedGuestMock.mockImplementation(() => (registered ? guest : null))
    registerBrowserHandlers({ getSettings: vi.fn() })
    const sender = {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents
    const setGrabModeHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:setGrabMode'
    )?.[1] as (
      event: { sender: Electron.WebContents },
      args: { browserPageId: string; enabled: boolean }
    ) => Promise<unknown>
    const registerHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:registerGuest'
    )?.[1] as (
      event: { sender: Electron.WebContents },
      args: {
        browserPageId: string
        workspaceId: string
        worktreeId: string
        webContentsId: number
      }
    ) => boolean

    const pendingEnable = setGrabModeHandler({ sender }, { browserPageId: 'page-1', enabled: true })
    await expect(
      setGrabModeHandler({ sender }, { browserPageId: 'page-1', enabled: false })
    ).resolves.toEqual({ ok: true })

    registered = true
    expect(
      registerHandler(
        { sender },
        {
          browserPageId: 'page-1',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          webContentsId: 123
        }
      )
    ).toBe(true)

    await expect(pendingEnable).resolves.toEqual({ ok: true })
    expect(setGrabModeMock).not.toHaveBeenCalled()
  })

  it('serializes in-flight mode changes so a stale enable cannot tear down the latest one', async () => {
    const guest = { id: 123 } as Electron.WebContents
    let resolveFirstEnable!: (success: boolean) => void
    const firstEnable = new Promise<boolean>((resolve) => {
      resolveFirstEnable = resolve
    })
    getAuthorizedGuestMock.mockReturnValue(guest)
    setGrabModeMock.mockReturnValueOnce(firstEnable).mockResolvedValue(true)
    registerBrowserHandlers({ getSettings: vi.fn() })
    const sender = {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents
    const setGrabModeHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:setGrabMode'
    )?.[1] as (
      event: { sender: Electron.WebContents },
      args: { browserPageId: string; enabled: boolean }
    ) => Promise<unknown>

    const staleEnable = setGrabModeHandler({ sender }, { browserPageId: 'page-1', enabled: true })
    await vi.waitFor(() => {
      expect(setGrabModeMock).toHaveBeenCalledTimes(1)
    })
    const disable = setGrabModeHandler({ sender }, { browserPageId: 'page-1', enabled: false })
    const latestEnable = setGrabModeHandler({ sender }, { browserPageId: 'page-1', enabled: true })

    resolveFirstEnable(true)
    await expect(Promise.all([staleEnable, disable, latestEnable])).resolves.toEqual([
      { ok: true },
      { ok: true },
      { ok: true }
    ])

    expect(setGrabModeMock.mock.calls).toEqual([
      ['page-1', true, guest],
      ['page-1', true, guest]
    ])
  })

  it('does not resolve worktree registration waits from a stale registered guest', async () => {
    getWebContentsIdByTabIdMock.mockReturnValue(new Map([['page-1', 123]]))
    getWorktreeIdForTabMock.mockReturnValue('worktree-1')
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => true })

    let resolved = false
    const wait = waitForWorktreeTabRegistration('worktree-1', 1000).then(() => {
      resolved = true
    })
    await Promise.resolve()

    expect(resolved).toBe(false)

    registerBrowserHandlers({ getSettings: vi.fn() })
    const registerHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:registerGuest'
    )?.[1] as (
      event: { sender: Electron.WebContents },
      args: {
        browserPageId: string
        workspaceId: string
        worktreeId: string
        webContentsId: number
      }
    ) => boolean

    const result = registerHandler(
      {
        sender: {
          id: 91,
          isDestroyed: () => false,
          getType: () => 'window',
          getURL: () => 'file:///renderer/index.html'
        } as Electron.WebContents
      },
      {
        browserPageId: 'page-1',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        webContentsId: 456
      }
    )

    expect(result).toBe(true)
    await expect(wait).resolves.toBeUndefined()
    expect(resolved).toBe(true)
  })

  // Annotation tools must enforce the same renderer ownership as grab tools.
  it('refuses an annotation viewport bridge request from a renderer that does not own the page', async () => {
    registerBrowserHandlers({ getSettings: vi.fn() })
    getAuthorizedGuestMock.mockReturnValue(null)

    const syncHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:setAnnotationViewportBridge'
    )?.[1] as (event: { sender: Electron.WebContents }, args: unknown) => Promise<boolean> | boolean

    const result = await syncHandler(
      {
        sender: {
          id: 91,
          isDestroyed: () => false,
          getType: () => 'window',
          getURL: () => 'file:///renderer/index.html'
        } as Electron.WebContents
      },
      {
        browserPageId: 'page-1',
        emitViewport: false,
        enabled: true,
        markers: [],
        token: 'annotationviewporttoken'
      }
    )

    expect(result).toBe(false)
    expect(setAnnotationViewportBridgeMock).not.toHaveBeenCalled()
  })
})
