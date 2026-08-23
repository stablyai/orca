import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'

const { clearCloseAuthority, closeAuthorityReady, stageCloseAuthority } = vi.hoisted(() => ({
  clearCloseAuthority: vi.fn(),
  closeAuthorityReady: vi.fn(() => true),
  stageCloseAuthority: vi.fn(() => ['closing-pty'])
}))

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('@electron-toolkit/utils', async () =>
  (await import('./createMainWindow-test-harness')).electronToolkitUtilsMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)
vi.mock('../ipc/pty', () => ({
  clearPtyRendererCloseAuthority: clearCloseAuthority,
  isPtyRendererCloseReady: closeAuthorityReady,
  stagePtyRendererCloseAuthority: stageCloseAuthority
}))

import { ipcMain } from 'electron'
import { getWindowSessionRegistry } from '../persistence/window-session-registry'
import { orcaWindowManager } from './orca-window-manager'
import { createMainWindow } from './createMainWindow'
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'

function createFixture() {
  const windowHandlers: Record<string, (...args: any[]) => void> = {}
  const ipcHandlers: Record<string, (...args: any[]) => void> = {}
  const webContents = {
    id: 42,
    on: vi.fn((event, handler) => {
      windowHandlers[event] = handler
    }),
    setZoomLevel: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    isCrashed: vi.fn(() => false),
    isDestroyed: vi.fn(() => false)
  }
  const instance = {
    id: 2,
    webContents,
    on: vi.fn((event, handler) => {
      windowHandlers[event] = handler
    }),
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    getSize: vi.fn(() => [1200, 800]),
    setSize: vi.fn(),
    maximize: vi.fn(),
    show: vi.fn(),
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    close: vi.fn(() => windowHandlers.close?.({ preventDefault: vi.fn() }))
  }
  browserWindowMock.mockImplementation(function () {
    return instance
  })
  vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
    ipcHandlers[channel] = handler as (...args: any[]) => void
    return ipcMain
  })
  return { instance, ipcHandlers, webContents, windowHandlers }
}

function transactionOptions(overrides: Record<string, unknown> = {}) {
  return {
    fenceTerminalTransfersForWindowClose: vi.fn(() => Promise.resolve()),
    hasPendingTerminalTransferForWindow: vi.fn(() => false),
    releaseTerminalTransferWindowCloseFence: vi.fn(),
    ...overrides
  }
}

function createStore() {
  return {
    getUI: vi.fn(() => ({})),
    getSettings: vi.fn(() => ({ windowBackgroundBlur: false })),
    getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
    getWorkspaceSessionHostIds: vi.fn(() => []),
    setWorkspaceSession: vi.fn(),
    stageWorkspaceSessionBeforeUnload: vi.fn(),
    updateUI: vi.fn()
  }
}

describe('main window terminal close transaction', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    clearCloseAuthority.mockClear()
    closeAuthorityReady.mockReset().mockReturnValue(true)
    stageCloseAuthority.mockReset().mockReturnValue(['closing-pty'])
  })

  afterEach(() => {
    orcaWindowManager.remove(2)
  })

  it('uses one transfer-fence, authority-stage, and request payload for native and rendered close', async () => {
    const { ipcHandlers, webContents, windowHandlers } = createFixture()
    const options = transactionOptions()
    createMainWindow(null, options)

    windowHandlers.close({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(stageCloseAuthority).toHaveBeenCalledTimes(1))
    windowHandlers['will-prevent-unload']()
    ipcHandlers['window:request-close']?.({ sender: webContents })
    await vi.waitFor(() => expect(stageCloseAuthority).toHaveBeenCalledTimes(2))

    expect(options.fenceTerminalTransfersForWindowClose).toHaveBeenCalledTimes(2)
    expect(options.fenceTerminalTransfersForWindowClose).toHaveBeenNthCalledWith(1, 2)
    expect(options.fenceTerminalTransfersForWindowClose).toHaveBeenNthCalledWith(2, 2)
    expect(webContents.send).toHaveBeenCalledTimes(3)
    const requests = webContents.send.mock.calls.filter(
      ([channel]) => channel === 'window:close-requested'
    )
    expect(requests).toEqual([
      [
        'window:close-requested',
        {
          isQuitting: false,
          requestId: expect.any(Number),
          ownedProviderPtyIds: ['closing-pty']
        }
      ],
      [
        'window:close-requested',
        {
          isQuitting: false,
          requestId: expect.any(Number),
          ownedProviderPtyIds: ['closing-pty']
        }
      ]
    ])
  })

  it('ignores a stale transfer fence after cancel while a retry proceeds', async () => {
    const { ipcHandlers, webContents, windowHandlers } = createFixture()
    let releaseFirstFence: () => void = () => {}
    const firstFence = new Promise<void>((resolve) => {
      releaseFirstFence = resolve
    })
    const options = transactionOptions({
      fenceTerminalTransfersForWindowClose: vi
        .fn()
        .mockImplementationOnce(() => firstFence)
        .mockResolvedValue(undefined)
    })
    createMainWindow(null, options)

    windowHandlers.close({ preventDefault: vi.fn() })
    await vi.waitFor(() =>
      expect(options.fenceTerminalTransfersForWindowClose).toHaveBeenCalledOnce()
    )
    ipcHandlers['window:cancel-close']?.({ sender: webContents })
    ipcHandlers['window:request-close']?.({ sender: webContents })
    await vi.waitFor(() => expect(stageCloseAuthority).toHaveBeenCalledOnce())

    releaseFirstFence()
    await firstFence
    await Promise.resolve()

    expect(stageCloseAuthority).toHaveBeenCalledOnce()
    expect(
      webContents.send.mock.calls.filter(([channel]) => channel === 'window:close-requested')
    ).toHaveLength(1)
  })

  it('blocks final confirmation while durable terminal membership remains', async () => {
    const { instance, ipcHandlers, webContents, windowHandlers } = createFixture()
    const store = createStore()
    const options = transactionOptions()
    createMainWindow(store as never, options)
    const session = getDefaultWorkspaceSession()
    session.terminalLayoutsByTabId['durable-tab'] = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: {}
    }
    getWindowSessionRegistry(store as never).seedWindow(2, new Map([['local', session]]))
    windowHandlers.close({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(stageCloseAuthority).toHaveBeenCalledOnce())
    const event = { sender: webContents, returnValue: undefined as boolean | undefined }

    ipcHandlers['window:confirm-close']?.(event)

    expect(event.returnValue).toBe(false)
    expect(instance.close).not.toHaveBeenCalled()
    expect(options.releaseTerminalTransferWindowCloseFence).toHaveBeenCalledWith(2)
  })

  it('blocks final confirmation when a transfer appears during the checkpoint', async () => {
    const { instance, ipcHandlers, webContents, windowHandlers } = createFixture()
    const options = transactionOptions({
      hasPendingTerminalTransferForWindow: vi.fn(() => true)
    })
    createMainWindow(null, options)
    windowHandlers.close({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(stageCloseAuthority).toHaveBeenCalledOnce())
    const event = { sender: webContents, returnValue: undefined as boolean | undefined }

    ipcHandlers['window:confirm-close']?.(event)

    expect(event.returnValue).toBe(false)
    expect(instance.close).not.toHaveBeenCalled()
    expect(clearCloseAuthority).toHaveBeenCalledWith(42)
  })

  it('does not stage user-close authority during App quit and clears stale transaction state', async () => {
    const { webContents, windowHandlers } = createFixture()
    const options = transactionOptions({ getIsQuitting: () => true })
    createMainWindow(null, options)

    windowHandlers.close({ preventDefault: vi.fn() })
    await vi.waitFor(() =>
      expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
        isQuitting: true,
        requestId: expect.any(Number)
      })
    )

    expect(stageCloseAuthority).not.toHaveBeenCalled()
    expect(options.fenceTerminalTransfersForWindowClose).not.toHaveBeenCalled()
    expect(clearCloseAuthority).toHaveBeenCalledWith(42)
  })

  it('clears close authority and the transfer fence when the renderer is destroyed', async () => {
    const { windowHandlers } = createFixture()
    const options = transactionOptions()
    createMainWindow(null, options)
    windowHandlers.close({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(stageCloseAuthority).toHaveBeenCalledOnce())

    windowHandlers.destroyed()

    expect(clearCloseAuthority).toHaveBeenCalledWith(42)
    expect(options.releaseTerminalTransferWindowCloseFence).toHaveBeenCalledWith(2)
  })

  it('releases a canceled transaction so the renderer can retry without stale authority', async () => {
    const { ipcHandlers, webContents, windowHandlers } = createFixture()
    const options = transactionOptions()
    createMainWindow(null, options)
    windowHandlers.close({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(stageCloseAuthority).toHaveBeenCalledOnce())

    ipcHandlers['window:cancel-close']?.({ sender: webContents })
    ipcHandlers['window:request-close']?.({ sender: webContents })
    await vi.waitFor(() => expect(stageCloseAuthority).toHaveBeenCalledTimes(2))

    expect(clearCloseAuthority).toHaveBeenCalledWith(42)
    expect(options.releaseTerminalTransferWindowCloseFence).toHaveBeenCalledWith(2)
  })
})
