import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const {
  appGetPathMock,
  registerSshHandlersMock,
  installRuntimeOwnedSshProviderMissRecoveryMock,
  reattachRuntimeOwnedSshTargetsAtStartupMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  registerSshHandlersMock: vi.fn(),
  installRuntimeOwnedSshProviderMissRecoveryMock: vi.fn(),
  reattachRuntimeOwnedSshTargetsAtStartupMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  clipboard: {},
  systemPreferences: {
    askForMediaAccess: vi.fn(async () => true),
    getMediaAccessStatus: vi.fn(() => 'granted')
  },
  ipcMain: {
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeListener: vi.fn(),
    removeHandler: vi.fn(),
    handle: vi.fn()
  },
  powerMonitor: { on: vi.fn(), off: vi.fn() }
}))
vi.mock('../ipc/repos', () => ({ registerRepoHandlers: vi.fn() }))
vi.mock('../ipc/repos/repos-changed-notification', () => ({
  setRepoRemoteClientNotifier: vi.fn()
}))
vi.mock('../ipc/watched-worktree-catalog-notification', () => ({
  setWorktreeCatalogRemoteClientNotifier: vi.fn()
}))
vi.mock('../ipc/worktrees', () => ({ registerWorktreeHandlers: vi.fn() }))
vi.mock('../ipc/worktree-change-invalidators', () => ({
  runWorktreeChangeInvalidators: vi.fn()
}))
vi.mock('../ipc/pty', () => ({ getLocalPtyProvider: vi.fn(), registerPtyHandlers: vi.fn() }))
vi.mock('../memory/hydrate-local-pty-registry', () => ({
  hydrateLocalPtyRegistryAtBoot: vi.fn()
}))
vi.mock('../ipc/ssh', () => ({ registerSshHandlers: registerSshHandlersMock }))
vi.mock('../ephemeral-vm-runtime-ssh-reattach', () => ({
  installRuntimeOwnedSshProviderMissRecovery: installRuntimeOwnedSshProviderMissRecoveryMock,
  reattachRuntimeOwnedSshTargetsAtStartup: reattachRuntimeOwnedSshTargetsAtStartupMock
}))
vi.mock('../ipc/worktree-base-directory-watcher', () => ({
  setWorktreeBaseDirectoryWatcherSyncContext: vi.fn(),
  scheduleWorktreeBaseDirectoryWatcherSync: vi.fn()
}))
vi.mock('../browser/browser-manager', () => ({ browserManager: { unregisterAll: vi.fn() } }))
vi.mock('../updater', () => ({
  checkForUpdates: vi.fn(),
  getUpdateStatus: vi.fn(),
  quitAndInstall: vi.fn(),
  dismissNudge: vi.fn(),
  setupAutoUpdater: vi.fn()
}))
vi.mock('../macos-tcc-prompt-notice', () => ({
  acknowledgePendingTccPromptNotice: vi.fn(),
  consumePendingTccPromptNotice: vi.fn(),
  dismissTccPromptNotice: vi.fn(),
  releasePendingTccPromptNotice: vi.fn()
}))

import { attachMainWindowServices } from './attach-main-window-services'

function createMainWindow(): unknown {
  return {
    id: 1,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    webContents: {
      id: 1,
      getURL: vi.fn(() => 'file:///opt/orca/renderer/index.html'),
      isDestroyed: vi.fn(() => false),
      isLoadingMainFrame: vi.fn(() => true),
      on: vi.fn(),
      reload: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
    }
  }
}

function createStore(): Store {
  return {
    getProfileStorageDirectory: vi.fn(() => '/profile-a'),
    flushPendingAsync: vi.fn(() => Promise.resolve())
  } as unknown as Store
}

function createRuntime(): unknown {
  return {
    attachWindow: vi.fn(),
    setNotifier: vi.fn(),
    markRendererReloading: vi.fn(),
    markRendererReloadCancelled: vi.fn(),
    markGraphReloadFailed: vi.fn(),
    markGraphUnavailable: vi.fn()
  }
}

describe('attachMainWindowServices: runtime-owned SSH relay re-attach', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    appGetPathMock.mockReturnValue('/user-data')
    reattachRuntimeOwnedSshTargetsAtStartupMock.mockResolvedValue(undefined)
  })

  it('installs the miss recovery and runs the startup pass after the SSH handlers can dial', () => {
    // Why: runtime-owned targets are skipped by the renderer's startup restore, the pane
    // connect gate, and the host list, so this wiring is the only thing that re-attaches
    // them after an app restart (#19173). Both calls must happen, in this order, after
    // `registerSshHandlers` has installed the connect they dial through.
    const order: string[] = []
    registerSshHandlersMock.mockImplementation(() => {
      order.push('registerSshHandlers')
    })
    installRuntimeOwnedSshProviderMissRecoveryMock.mockImplementation(() => {
      order.push('installRecovery')
    })
    reattachRuntimeOwnedSshTargetsAtStartupMock.mockImplementation(async () => {
      order.push('reattachAtStartup')
    })

    attachMainWindowServices(createMainWindow() as never, createStore(), createRuntime() as never)

    expect(order).toEqual(['registerSshHandlers', 'installRecovery', 'reattachAtStartup'])
  })

  it('hands both the live userData path resolver, not a snapshot', () => {
    attachMainWindowServices(createMainWindow() as never, createStore(), createRuntime() as never)

    const [installGetUserDataPath] = installRuntimeOwnedSshProviderMissRecoveryMock.mock.calls[0]
    const [reattachGetUserDataPath] = reattachRuntimeOwnedSshTargetsAtStartupMock.mock.calls[0]
    expect(installGetUserDataPath()).toBe('/user-data')
    expect(reattachGetUserDataPath()).toBe('/user-data')
    expect(appGetPathMock).toHaveBeenCalledWith('userData')
  })
})
