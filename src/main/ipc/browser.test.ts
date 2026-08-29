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

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: browserWindowFromWebContentsMock
  },
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock
  },
  webContents: {
    fromId: webContentsFromIdMock
  }
}))

vi.mock('../browser/browser-manager', () => ({
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
import {
  waitForAnyTabRegistration,
  waitForTabRegistration,
  waitForWorktreeTabRegistration
} from './browser-tab-registration-wait'

describe('registerBrowserHandlers', () => {
  beforeEach(() => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
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

  it('rejects non-window callers', async () => {
    registerBrowserHandlers()

    const registerHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:registerGuest'
    )?.[1] as (event: { sender: Electron.WebContents }, args: unknown) => boolean

    const result = registerHandler(
      {
        sender: {
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'http://localhost:5173/'
        } as Electron.WebContents
      },
      { browserTabId: 'browser-1', webContentsId: 101 }
    )

    expect(result).toBe(false)
    expect(registerGuestMock).not.toHaveBeenCalled()
  })

  it('does not resolve registration waiters when BrowserManager rejects the guest', async () => {
    vi.useFakeTimers()
    try {
      registerGuestMock.mockReturnValue(false)
      const settled = Promise.allSettled([waitForTabRegistration('page-1', 1000)])
      registerBrowserHandlers()
      const registerHandler = handleMock.mock.calls.find(
        ([channel]) => channel === 'browser:registerGuest'
      )?.[1] as (event: { sender: Electron.WebContents }, args: object) => boolean

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
          webContentsId: 123
        }
      )

      expect(result).toBe(false)
      await vi.advanceTimersByTimeAsync(1001)
      expect(await settled).toEqual([{ status: 'rejected', reason: expect.any(Error) }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('validates exact live guest registration only for the trusted renderer', () => {
    getGuestWebContentsIdMock.mockReturnValue(123)
    registerBrowserHandlers()
    const validateHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:isGuestRegistered'
    )?.[1] as (event: { sender: Electron.WebContents }, args: unknown) => boolean
    const trustedSender = {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents

    expect(
      validateHandler({ sender: trustedSender }, { browserPageId: 'page-1', webContentsId: 123 })
    ).toBe(true)
    expect(
      validateHandler({ sender: trustedSender }, { browserPageId: 'page-1', webContentsId: 124 })
    ).toBe(false)

    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => true })
    expect(
      validateHandler({ sender: trustedSender }, { browserPageId: 'page-1', webContentsId: 123 })
    ).toBe(false)
    expect(
      validateHandler(
        {
          sender: {
            id: 92,
            isDestroyed: () => false,
            getType: () => 'webview',
            getURL: () => 'https://example.com'
          } as Electron.WebContents
        },
        { browserPageId: 'page-1', webContentsId: 123 }
      )
    ).toBe(false)
  })

  it('repairs only a live webview owned by the trusted renderer', () => {
    registerBrowserHandlers()
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
    const trustedSender = {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents
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

  it('authorizes browser download cancellation through the owning renderer', () => {
    cancelDownloadMock.mockReturnValue(true)
    registerBrowserHandlers()

    const cancelHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:cancelDownload'
    )?.[1] as (event: { sender: Electron.WebContents }, args: { downloadId: string }) => boolean

    const sender = {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents

    const result = cancelHandler({ sender }, { downloadId: 'download-1' })

    expect(cancelDownloadMock).toHaveBeenCalledWith({
      downloadId: 'download-1',
      senderWebContentsId: 91
    })
    expect(result).toBe(true)
  })

  it('rejects browser download cancellation from untrusted callers', () => {
    registerBrowserHandlers()

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
    registerBrowserHandlers()
    const proceedHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:proceedCertificate'
    )?.[1] as (event: { sender: Electron.WebContents }, args: unknown) => unknown
    const trustedSender = {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents

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
    expect(proceedCertificateMock).not.toHaveBeenCalled()
  })

  it('rejects malformed certificate approval IPC arguments', () => {
    registerBrowserHandlers()
    const proceedHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:proceedCertificate'
    )?.[1] as (event: { sender: Electron.WebContents }, args: unknown) => unknown
    const sender = {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents

    for (const args of [null, {}, { browserPageId: 1, challengeId: 'challenge-1' }]) {
      expect(proceedHandler({ sender }, args)).toEqual({ ok: false, reason: 'missing' })
    }
    expect(proceedCertificateMock).not.toHaveBeenCalled()
  })

  it('updates the bridge active tab for the owning worktree', async () => {
    const onTabChangedMock = vi.fn()
    getGuestWebContentsIdMock.mockReturnValue(4242)
    getWorktreeIdForTabMock.mockReturnValue('wt-browser')

    setAgentBrowserBridgeRef({ onTabChanged: onTabChangedMock } as never)
    registerBrowserHandlers()

    const activeTabChangedHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:activeTabChanged'
    )?.[1] as (event: { sender: Electron.WebContents }, args: { browserPageId: string }) => boolean

    const result = activeTabChangedHandler(
      {
        sender: {
          isDestroyed: () => false,
          getType: () => 'window',
          getURL: () => 'file:///renderer/index.html'
        } as Electron.WebContents
      },
      { browserPageId: 'page-1' }
    )

    expect(result).toBe(true)
    expect(onTabChangedMock).toHaveBeenCalledWith(4242, 'wt-browser')
  })

  it('resolves concurrent tab registration waiters for the same page', async () => {
    vi.useFakeTimers()
    try {
      getGuestWebContentsIdMock.mockReturnValue(null)
      const first = waitForTabRegistration('page-1', 1000)
      const second = waitForTabRegistration('page-1', 1000)
      const settled = Promise.allSettled([first, second])

      registerBrowserHandlers()

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
          webContentsId: 123
        }
      )

      expect(result).toBe(true)
      await vi.advanceTimersByTimeAsync(1001)
      expect(await settled).toEqual([
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for authorized registration even when an old guest is still live', async () => {
    const guest = { id: 123 } as Electron.WebContents
    getGuestWebContentsIdMock.mockReturnValue(122)
    getAuthorizedGuestMock.mockReturnValueOnce(null).mockReturnValue(guest)
    registerBrowserHandlers()
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

    const pendingResult = setGrabModeHandler({ sender }, { browserPageId: 'page-1', enabled: true })
    await Promise.resolve()
    expect(setGrabModeMock).not.toHaveBeenCalled()

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

    await expect(pendingResult).resolves.toEqual({ ok: true })
    expect(setGrabModeMock).toHaveBeenCalledWith('page-1', true, guest)
  })

  it('returns not-ready when grab registration does not arrive', async () => {
    vi.useFakeTimers()
    try {
      getGuestWebContentsIdMock.mockReturnValue(null)
      getAuthorizedGuestMock.mockReturnValue(null)
      registerBrowserHandlers()
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

      const pendingResult = setGrabModeHandler(
        { sender },
        { browserPageId: 'page-1', enabled: true }
      )
      await vi.advanceTimersByTimeAsync(1_001)

      await expect(pendingResult).resolves.toEqual({ ok: false, reason: 'not-ready' })
      expect(setGrabModeMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not enable grab mode after a pending request is cancelled', async () => {
    const guest = { id: 123 } as Electron.WebContents
    let registered = false
    getAuthorizedGuestMock.mockImplementation(() => (registered ? guest : null))
    registerBrowserHandlers()
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

  it('coalesces a cancelled pending enable into one later enable', async () => {
    const guest = { id: 123 } as Electron.WebContents
    let registered = false
    getAuthorizedGuestMock.mockImplementation(() => (registered ? guest : null))
    registerBrowserHandlers()
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

    const firstEnable = setGrabModeHandler({ sender }, { browserPageId: 'page-1', enabled: true })
    await setGrabModeHandler({ sender }, { browserPageId: 'page-1', enabled: false })
    const latestEnable = setGrabModeHandler({ sender }, { browserPageId: 'page-1', enabled: true })

    registered = true
    registerHandler(
      { sender },
      {
        browserPageId: 'page-1',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        webContentsId: 123
      }
    )

    await expect(Promise.all([firstEnable, latestEnable])).resolves.toEqual([
      { ok: true },
      { ok: true }
    ])
    expect(setGrabModeMock).toHaveBeenCalledTimes(1)
    expect(setGrabModeMock).toHaveBeenCalledWith('page-1', true, guest)
  })

  it('serializes in-flight mode changes so a stale enable cannot tear down the latest one', async () => {
    const guest = { id: 123 } as Electron.WebContents
    let resolveFirstEnable!: (success: boolean) => void
    const firstEnable = new Promise<boolean>((resolve) => {
      resolveFirstEnable = resolve
    })
    getAuthorizedGuestMock.mockReturnValue(guest)
    setGrabModeMock.mockReturnValueOnce(firstEnable).mockResolvedValue(true)
    registerBrowserHandlers()
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

  it('distinguishes picker injection failure from guest readiness', async () => {
    const guest = { id: 123 } as Electron.WebContents
    getAuthorizedGuestMock.mockReturnValue(guest)
    setGrabModeMock.mockResolvedValue(false)
    registerBrowserHandlers()
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

    await expect(
      setGrabModeHandler({ sender }, { browserPageId: 'page-1', enabled: true })
    ).resolves.toEqual({ ok: false, reason: 'injection-failed' })
  })

  it('resolves worktree and any-tab registration waiters when a guest registers', async () => {
    vi.useFakeTimers()
    try {
      getWebContentsIdByTabIdMock.mockReturnValue(new Map())
      const worktreeWait = waitForWorktreeTabRegistration('worktree-1', 1000)
      const anyWait = waitForAnyTabRegistration(1000)
      const settled = Promise.allSettled([worktreeWait, anyWait])

      registerBrowserHandlers()

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
          browserPageId: 'page-worktree-1',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          webContentsId: 123
        }
      )

      expect(result).toBe(true)
      await vi.advanceTimersByTimeAsync(1001)
      expect(await settled).toEqual([
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves worktree registration waits immediately when a tab is already registered', async () => {
    getWebContentsIdByTabIdMock.mockReturnValue(new Map([['page-1', 123]]))
    getWorktreeIdForTabMock.mockReturnValue('worktree-1')

    await expect(waitForWorktreeTabRegistration('worktree-1', 1000)).resolves.toBeUndefined()

    expect(getWorktreeIdForTabMock).toHaveBeenCalledWith('page-1')
  })

  it('resolves any-tab registration waits immediately when a tab is already registered', async () => {
    getWebContentsIdByTabIdMock.mockReturnValue(new Map([['page-1', 123]]))

    await expect(waitForAnyTabRegistration(1000)).resolves.toBeUndefined()
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

    registerBrowserHandlers()
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

  it('validates annotation viewport bridge requests before syncing to the guest', async () => {
    registerBrowserHandlers()
    const guest = { isDestroyed: () => false } as Electron.WebContents
    getAuthorizedGuestMock.mockReturnValue(guest)

    const syncHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:setAnnotationViewportBridge'
    )?.[1] as (event: { sender: Electron.WebContents }, args: unknown) => Promise<boolean> | boolean

    const sender = {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents

    const result = await syncHandler(
      { sender },
      {
        browserPageId: 'page-1',
        emitViewport: false,
        enabled: true,
        markers: [],
        token: 'annotationviewporttoken'
      }
    )

    expect(result).toBe(true)
    expect(setAnnotationViewportBridgeMock).toHaveBeenCalledWith(
      'page-1',
      {
        emitViewport: false,
        enabled: true,
        markers: [],
        token: 'annotationviewporttoken'
      },
      // Why a resolver and not the guest: the op is serialized per page, so it has to read the
      // registry when it runs — a navigation while it waited may have swapped the contents.
      // Which guest it then resolves is pinned in browser-manager-annotation-bridge.test.ts.
      expect.any(Function)
    )
  })

  // Why this is new: the channel used to hand a page id straight to the manager, so any trusted
  // renderer could drive any page's guest. It now resolves through the same authority the grab
  // channels use, which pins the request to the renderer that registered the page.
  it('refuses an annotation viewport bridge request from a renderer that does not own the page', async () => {
    registerBrowserHandlers()
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

  it('rejects invalid annotation viewport bridge requests', async () => {
    registerBrowserHandlers()

    const syncHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:setAnnotationViewportBridge'
    )?.[1] as (event: { sender: Electron.WebContents }, args: unknown) => boolean

    const result = syncHandler(
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
        token: 'short'
      }
    )

    expect(result).toBe(false)
    expect(setAnnotationViewportBridgeMock).not.toHaveBeenCalled()
  })
})
