import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  removeHandlerMock,
  handleMock,
  registerGuestMock,
  unregisterGuestMock,
  getGuestWebContentsIdMock,
  getWorktreeIdForTabMock,
  openDevToolsMock,
  setAnnotationViewportBridgeMock,
  getDownloadPromptMock,
  acceptDownloadMock,
  cancelDownloadMock,
  showSaveDialogMock,
  browserWindowFromWebContentsMock
} = vi.hoisted(() => ({
  removeHandlerMock: vi.fn(),
  handleMock: vi.fn(),
  registerGuestMock: vi.fn(),
  unregisterGuestMock: vi.fn(),
  getGuestWebContentsIdMock: vi.fn(),
  getWorktreeIdForTabMock: vi.fn(),
  openDevToolsMock: vi.fn().mockResolvedValue(true),
  setAnnotationViewportBridgeMock: vi.fn().mockResolvedValue(true),
  getDownloadPromptMock: vi.fn(),
  acceptDownloadMock: vi.fn(),
  cancelDownloadMock: vi.fn(),
  showSaveDialogMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: browserWindowFromWebContentsMock
  },
  dialog: {
    showSaveDialog: showSaveDialogMock
  },
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock
  }
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: {
    registerGuest: registerGuestMock,
    unregisterGuest: unregisterGuestMock,
    getGuestWebContentsId: getGuestWebContentsIdMock,
    getWorktreeIdForTab: getWorktreeIdForTabMock,
    openDevTools: openDevToolsMock,
    setAnnotationViewportBridge: setAnnotationViewportBridgeMock,
    getDownloadPrompt: getDownloadPromptMock,
    acceptDownload: acceptDownloadMock,
    cancelDownload: cancelDownloadMock
  }
}))

import { registerBrowserHandlers, setAgentBrowserBridgeRef } from './browser'

describe('registerBrowserHandlers', () => {
  beforeEach(() => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    removeHandlerMock.mockReset()
    handleMock.mockReset()
    registerGuestMock.mockReset()
    unregisterGuestMock.mockReset()
    getGuestWebContentsIdMock.mockReset()
    getWorktreeIdForTabMock.mockReset()
    openDevToolsMock.mockReset()
    setAnnotationViewportBridgeMock.mockReset()
    getDownloadPromptMock.mockReset()
    acceptDownloadMock.mockReset()
    cancelDownloadMock.mockReset()
    showSaveDialogMock.mockReset()
    browserWindowFromWebContentsMock.mockReset()
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

  it('accepts downloads through a main-owned save dialog', async () => {
    getDownloadPromptMock.mockReturnValue({ filename: 'report.csv' })
    acceptDownloadMock.mockReturnValue({ ok: true })
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/tmp/report.csv' })

    registerBrowserHandlers()

    const acceptHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:acceptDownload'
    )?.[1] as (
      event: { sender: Electron.WebContents },
      args: { downloadId: string }
    ) => Promise<{ ok: true } | { ok: false; reason: string }>

    const sender = {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents

    const result = await acceptHandler({ sender }, { downloadId: 'download-1' })

    expect(showSaveDialogMock).toHaveBeenCalledTimes(1)
    expect(acceptDownloadMock).toHaveBeenCalledWith({
      downloadId: 'download-1',
      senderWebContentsId: 91,
      savePath: '/tmp/report.csv'
    })
    expect(result).toEqual({ ok: true })
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

  it('validates annotation viewport bridge requests before syncing to the guest', async () => {
    registerBrowserHandlers()

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
    expect(setAnnotationViewportBridgeMock).toHaveBeenCalledWith('page-1', {
      emitViewport: false,
      enabled: true,
      markers: [],
      token: 'annotationviewporttoken'
    })
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
