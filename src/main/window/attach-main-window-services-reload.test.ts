import { beforeEach, describe, expect, it, vi } from 'vitest'

type RendererReloadArgs = { webContentsId: number; ignoreCache: boolean }
type RendererReloadCallback = (args: RendererReloadArgs) => void
type ReloadHandler = (event: { sender: { id: number } }) => Promise<unknown>
type IpcHandle = (channel: string, handler: ReloadHandler) => void

const { handleMock, netFetchMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn<IpcHandle>(),
  netFetchMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: removeHandlerMock,
    removeListener: vi.fn()
  },
  net: { fetch: netFetchMock }
}))

vi.mock('../browser/browser-manager', () => ({ browserManager: { unregisterAll: vi.fn() } }))
vi.mock('../browser/browser-media-access', () => ({
  hasSystemMediaAccess: vi.fn(),
  requestSystemMediaAccess: vi.fn()
}))
vi.mock('../ipc/folder-repo-git-upgrade', () => ({ startFolderRepoGitUpgradeWatch: vi.fn() }))
vi.mock('../ipc/pty', () => ({ getLocalPtyProvider: vi.fn(), registerPtyHandlers: vi.fn() }))
vi.mock('../ipc/pty-management', () => ({ registerDaemonManagementHandlers: vi.fn() }))
vi.mock('../ipc/remote-workspace', () => ({ registerRemoteWorkspaceHandlers: vi.fn() }))
vi.mock('../ipc/repos', () => ({ registerRepoHandlers: vi.fn() }))
vi.mock('../ipc/repos/repos-changed-notification', () => ({
  setRepoRemoteClientNotifier: vi.fn()
}))
vi.mock('../ipc/ssh', () => ({ registerSshHandlers: vi.fn() }))
vi.mock('../ipc/watched-worktree-catalog-notification', () => ({
  setWorktreeCatalogRemoteClientNotifier: vi.fn()
}))
vi.mock('../ipc/workspace-cleanup', () => ({ registerWorkspaceCleanupHandlers: vi.fn() }))
vi.mock('../ipc/worktree-base-directory-watcher', () => ({
  scheduleWorktreeBaseDirectoryWatcherSync: vi.fn(),
  setWorktreeBaseDirectoryWatcherSyncContext: vi.fn()
}))
vi.mock('../ipc/worktrees', () => ({ registerWorktreeHandlers: vi.fn() }))
vi.mock('../macos-tcc-prompt-notice', () => ({
  acknowledgePendingTccPromptNotice: vi.fn(),
  consumePendingTccPromptNotice: vi.fn(),
  dismissTccPromptNotice: vi.fn(),
  releasePendingTccPromptNotice: vi.fn()
}))
vi.mock('../memory/hydrate-local-pty-registry', () => ({
  hydrateLocalPtyRegistryAtBoot: vi.fn()
}))
vi.mock('../terminal-history-gc', () => ({ scheduleHistoryGc: vi.fn() }))
vi.mock('./history-gc-worktree-ids', () => ({ getKnownWorktreeIdsForHistoryGc: vi.fn() }))
vi.mock('./main-window-updater', () => ({
  ensureAutoUpdaterConfigured: vi.fn(),
  registerUpdaterHandlers: vi.fn(),
  scheduleMainWindowAutoUpdaterSetup: vi.fn()
}))
vi.mock('./runtime-window-lifecycle', () => ({ registerRuntimeWindowLifecycle: vi.fn() }))

import { attachMainWindowServices } from './attach-main-window-services'

type MockFn = ReturnType<typeof vi.fn>

function createMainWindow(documentUrl: string): {
  isDestroyed: MockFn
  on: MockFn
  webContents: {
    getURL: MockFn
    id: number
    isDestroyed: MockFn
    isLoadingMainFrame: MockFn
    on: MockFn
    reload: MockFn
    session: {
      setPermissionCheckHandler: MockFn
      setPermissionRequestHandler: MockFn
    }
  }
} {
  return {
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    webContents: {
      getURL: vi.fn(() => documentUrl),
      id: 1,
      isDestroyed: vi.fn(() => false),
      isLoadingMainFrame: vi.fn(() => true),
      on: vi.fn(),
      reload: vi.fn(),
      session: {
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn()
      }
    }
  }
}

function getReloadHandler(): ReloadHandler {
  const handler = handleMock.mock.calls.find(([channel]) => channel === 'app:reload')?.[1]
  expect(handler).toBeTypeOf('function')
  if (typeof handler !== 'function') {
    throw new Error('Reload handler was not registered')
  }
  return handler
}

function attachReloadHandler(
  mainWindow: ReturnType<typeof createMainWindow>,
  onBeforeRendererReload: RendererReloadCallback
): void {
  attachMainWindowServices(mainWindow as never, {} as never, {} as never, undefined, undefined, {
    onBeforeRendererReload
  })
}

describe('app reload availability', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('reloads a non-http app renderer and marks expected renderer teardown', async () => {
    const onBeforeRendererReload = vi.fn<RendererReloadCallback>()
    const mainWindow = createMainWindow('file:///opt/orca/renderer/index.html')
    attachReloadHandler(mainWindow, onBeforeRendererReload)

    expect(removeHandlerMock).toHaveBeenCalledWith('app:reload')
    await getReloadHandler()({ sender: mainWindow.webContents })

    expect(onBeforeRendererReload).toHaveBeenCalledWith({
      webContentsId: 1,
      ignoreCache: false
    })
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(mainWindow.webContents.reload).toHaveBeenCalledOnce()
  })

  it('reloads an available http app renderer after checking its origin', async () => {
    const onBeforeRendererReload = vi.fn<RendererReloadCallback>()
    const mainWindow = createMainWindow('http://127.0.0.1:5173/worktree')
    netFetchMock.mockResolvedValue({ ok: true, status: 200 })
    attachReloadHandler(mainWindow, onBeforeRendererReload)

    await getReloadHandler()({ sender: mainWindow.webContents })

    expect(netFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:5173',
      expect.objectContaining({ method: 'HEAD', signal: expect.any(AbortSignal) })
    )
    expect(onBeforeRendererReload).toHaveBeenCalledWith({
      webContentsId: 1,
      ignoreCache: false
    })
    expect(mainWindow.webContents.reload).toHaveBeenCalledOnce()
  })

  it('rejects an app reload when the current http origin is unavailable', async () => {
    const onBeforeRendererReload = vi.fn<RendererReloadCallback>()
    const mainWindow = createMainWindow('http://127.0.0.1:5173/worktree')
    netFetchMock.mockRejectedValue(new Error('connection refused'))
    attachReloadHandler(mainWindow, onBeforeRendererReload)

    await expect(getReloadHandler()({ sender: mainWindow.webContents })).rejects.toThrow(
      'Renderer origin is unavailable: http://127.0.0.1:5173'
    )
    expect(onBeforeRendererReload).not.toHaveBeenCalled()
    expect(mainWindow.webContents.reload).not.toHaveBeenCalled()
  })
})
