import { ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { Store } from '../persistence'
import {
  acknowledgePendingTccPromptNotice,
  consumePendingTccPromptNotice,
  dismissTccPromptNotice,
  releasePendingTccPromptNotice
} from '../macos-tcc-prompt-notice'
import { registerRepoHandlers } from '../ipc/repos'
import { setRepoRemoteClientNotifier } from '../ipc/repos/repos-changed-notification'
import { setWorktreeCatalogRemoteClientNotifier } from '../ipc/watched-worktree-catalog-notification'
import { registerWorktreeHandlers } from '../ipc/worktrees'
import { registerWorkspaceCleanupHandlers } from '../ipc/workspace-cleanup'
import {
  registerPtyHandlers,
  type CodexHomePtySpawnedLifecycleArgs,
  type GetSelectedCodexHomePath,
  type PrepareCodexSessionResume
} from '../ipc/pty'
import { registerDaemonManagementHandlers } from '../ipc/pty-management'
import { registerSshHandlers } from '../ipc/ssh'
import { registerRemoteWorkspaceHandlers } from '../ipc/remote-workspace'
import { browserManager } from '../browser/browser-manager'
import { hasSystemMediaAccess, requestSystemMediaAccess } from '../browser/browser-media-access'
import type { OrcaRuntimeService, RuntimeWorktreeLifecycleEvent } from '../runtime/orca-runtime'
import type { UpdateInstallMode } from '../updater'
import { scheduleHistoryGc } from '../terminal-history-gc'
import { hydrateLocalPtyRegistryAtBoot } from '../memory/hydrate-local-pty-registry'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { getKnownWorktreeIdsForHistoryGc } from './history-gc-worktree-ids'
import { isNativeFileDropPayload, type NativeFileDropPayload } from '../../shared/native-file-drop'
import type { ClaudeAccountSelectionTarget } from '../claude-accounts/runtime-selection'
import {
  scheduleWorktreeBaseDirectoryWatcherSync,
  setWorktreeBaseDirectoryWatcherSyncContext
} from '../ipc/worktree-base-directory-watcher'
import { startFolderRepoGitUpgradeWatch } from '../ipc/folder-repo-git-upgrade'
import { scheduleMainWindowAutoUpdaterSetup } from './main-window-updater'
import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'

export { ensureAutoUpdaterConfigured, registerUpdaterHandlers } from './main-window-updater'

let appReloadHandlerTokenCounter = 0
let activeAppReloadHandlerToken: number | null = null
let tccPromptHandlerTokenCounter = 0
let activeTccPromptHandlerToken: number | null = null

export function attachMainWindowServices(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService,
  getSelectedCodexHomePath?: GetSelectedCodexHomePath,
  prepareClaudeAuth?: (
    target?: ClaudeAccountSelectionTarget
  ) => Promise<ClaudeRuntimeAuthPreparation>,
  options?: {
    prepareCodexSessionResume?: PrepareCodexSessionResume
    awaitLocalPtyStartup?: () => Promise<void>
    awaitLocalPtyProviderStartup?: () => Promise<void>
    onBeforeRendererReload?: (args: { webContentsId: number; ignoreCache: boolean }) => void
    // Why: lets the PTY orphan sweep skip the one crash-recovery reload (#5787).
    isRecoveryReloadInFlight?: (webContentsId: number) => boolean
    onCodexHomePtySpawned?: (args: CodexHomePtySpawnedLifecycleArgs) => void
    onPtyExit?: (id: string, exitSequence: number) => void
    onBeforeUpdateQuit?: () => void | Promise<void>
    updateInstallMode?: UpdateInstallMode
    onWorktreeLifecycle?: (event: RuntimeWorktreeLifecycleEvent) => void
  }
): void {
  registerAppReloadHandler(mainWindow, options?.onBeforeRendererReload)
  registerRepoHandlers(mainWindow, store, runtime)
  // Why: repo IPC mutations must also invalidate paired clients' catalogs (#11994).
  setRepoRemoteClientNotifier(runtime)
  setWorktreeCatalogRemoteClientNotifier(runtime)
  registerWorktreeHandlers(mainWindow, store, runtime, {
    onWorktreeLifecycle: options?.onWorktreeLifecycle
  })
  // Why: repo/settings mutations resync watchers through this attached main-window context.
  setWorktreeBaseDirectoryWatcherSyncContext(store, mainWindow)
  scheduleWorktreeBaseDirectoryWatcherSync(store, mainWindow)
  // Why: folder projects get no watch target, so an external `git init` needs its own
  // marker poll to upgrade them without a restart (#11477).
  startFolderRepoGitUpgradeWatch(store, mainWindow)
  registerWorkspaceCleanupHandlers(store)
  registerPtyHandlers(
    mainWindow,
    runtime,
    getSelectedCodexHomePath,
    () => store.getSettings(),
    prepareClaudeAuth,
    store,
    {
      prepareCodexSessionResume: options?.prepareCodexSessionResume,
      awaitLocalPtyStartup: options?.awaitLocalPtyStartup,
      awaitLocalPtyProviderStartup: options?.awaitLocalPtyProviderStartup,
      isRecoveryReloadInFlight: options?.isRecoveryReloadInFlight,
      onCodexHomePtySpawned: options?.onCodexHomePtySpawned,
      onPtyExit: options?.onPtyExit
    }
  )
  // Why: register after registerPtyHandlers so pty:management:* IPC re-installs on macOS re-activation (docs/daemon-staleness-ux.md §Phase 1).
  registerDaemonManagementHandlers()
  // Why: don't enumerate repo paths in background GC — `git worktree list` can touch protected macOS folders and trigger access prompts.
  scheduleHistoryGc(async () => {
    return getKnownWorktreeIdsForHistoryGc(store)
  })
  const localPtyProviderStartupReady = options?.awaitLocalPtyProviderStartup?.()
  if (localPtyProviderStartupReady) {
    void localPtyProviderStartupReady
      .then(() => hydrateLocalPtyRegistryAtBoot(store))
      .catch((error) => {
        console.warn(
          '[memory] Deferred pty-registry hydration skipped:',
          error instanceof Error ? error.message : String(error)
        )
      })
  } else {
    void hydrateLocalPtyRegistryAtBoot(store)
  }
  registerSshHandlers(store, () => mainWindow, runtime)
  registerRemoteWorkspaceHandlers(store, () => mainWindow)
  registerFileDropRelay(mainWindow)
  registerTccPromptNoticeHandlers(mainWindow)
  scheduleMainWindowAutoUpdaterSetup(mainWindow, store, options)
  registerRuntimeWindowLifecycle(mainWindow, runtime)

  const allowedPermissions = new Set(['media', 'fullscreen', 'pointerLock'])
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      if (permission === 'media') {
        void requestSystemMediaAccess(details).then(callback, (error: unknown) => {
          console.error('[permissions] Failed to request media access:', error)
          callback(false)
        })
        return
      }
      callback(allowedPermissions.has(permission))
    }
  )
  mainWindow.webContents.session.setPermissionCheckHandler(
    (_webContents, permission, _origin, details) => {
      if (permission !== 'media') {
        return allowedPermissions.has(permission)
      }
      return hasSystemMediaAccess(details?.mediaType)
    }
  )

  mainWindow.on('closed', () => {
    // Why: clear main-owned guest registrations on close so stale tab→webContents ids don't leak across relaunch/hot-reload.
    browserManager.unregisterAll()
  })
}

function registerTccPromptNoticeHandlers(mainWindow: BrowserWindow): void {
  const handlerToken = ++tccPromptHandlerTokenCounter
  if (activeTccPromptHandlerToken !== null) {
    releasePendingTccPromptNotice(activeTccPromptHandlerToken)
  }
  activeTccPromptHandlerToken = handlerToken
  const consumeChannel = 'macosTccPrompts:consumePending'
  const acknowledgeChannel = 'macosTccPrompts:acknowledgePending'
  const releaseChannel = 'macosTccPrompts:releasePending'
  const dismissChannel = 'macosTccPrompts:dismiss'
  ipcMain.removeHandler(consumeChannel)
  ipcMain.removeHandler(acknowledgeChannel)
  ipcMain.removeHandler(releaseChannel)
  ipcMain.removeHandler(dismissChannel)
  const mainWebContents = mainWindow.webContents
  const releaseOwnerClaim = (): void => releasePendingTccPromptNotice(handlerToken)
  // Why: a renderer reload/crash destroys its claim callbacks without closing the BrowserWindow.
  mainWebContents.on('did-start-loading', () => {
    if (mainWebContents.isLoadingMainFrame()) {
      releaseOwnerClaim()
    }
  })
  mainWebContents.on('render-process-gone', releaseOwnerClaim)
  const ownsNotice = (event: IpcMainInvokeEvent): boolean =>
    !mainWindow.isDestroyed() && !mainWebContents.isDestroyed() && event.sender === mainWebContents
  ipcMain.handle(consumeChannel, (event) =>
    ownsNotice(event) ? consumePendingTccPromptNotice(handlerToken) : null
  )
  ipcMain.handle(acknowledgeChannel, (event, claimId: number) => {
    if (ownsNotice(event) && Number.isSafeInteger(claimId)) {
      acknowledgePendingTccPromptNotice(handlerToken, claimId)
    }
  })
  ipcMain.handle(releaseChannel, (event, claimId: number) => {
    if (ownsNotice(event) && Number.isSafeInteger(claimId)) {
      releasePendingTccPromptNotice(handlerToken, claimId)
    }
  })
  ipcMain.handle(dismissChannel, (event) => {
    if (ownsNotice(event)) {
      dismissTccPromptNotice()
    }
  })
  // Why: macOS can stay windowless; drop stale closures without letting an old close clear newer handlers.
  mainWindow.on('closed', () => {
    if (activeTccPromptHandlerToken !== handlerToken) {
      return
    }
    releaseOwnerClaim()
    ipcMain.removeHandler(consumeChannel)
    ipcMain.removeHandler(acknowledgeChannel)
    ipcMain.removeHandler(releaseChannel)
    ipcMain.removeHandler(dismissChannel)
    activeTccPromptHandlerToken = null
  })
}

function registerAppReloadHandler(
  mainWindow: BrowserWindow,
  onBeforeRendererReload?: (args: { webContentsId: number; ignoreCache: boolean }) => void
): void {
  // Why: the process-global IPC handler can outlive the window, so guard both lifetimes before using the WebContents.
  const handlerToken = ++appReloadHandlerTokenCounter
  activeAppReloadHandlerToken = handlerToken
  const mainWebContents = mainWindow.webContents
  ipcMain.removeHandler('app:reload')
  ipcMain.handle('app:reload', (event) => {
    if (
      mainWindow.isDestroyed() ||
      mainWebContents.isDestroyed() ||
      event.sender !== mainWebContents
    ) {
      return
    }
    onBeforeRendererReload?.({ webContentsId: mainWebContents.id, ignoreCache: false })
    mainWebContents.reload()
  })
  mainWindow.on('closed', () => {
    if (activeAppReloadHandlerToken !== handlerToken) {
      return
    }
    // Why: macOS keeps the process alive with no window; this handler would otherwise retain the closed window until reopen.
    ipcMain.removeHandler('app:reload')
    activeAppReloadHandlerToken = null
  })
}

function registerFileDropRelay(mainWindow: BrowserWindow): void {
  const channel = 'terminal:file-dropped-from-preload'
  const mainWebContents = mainWindow.webContents
  ipcMain.removeAllListeners(channel)
  const relayFileDrop = (event: Electron.IpcMainEvent, args: NativeFileDropPayload): void => {
    if (
      mainWindow.isDestroyed() ||
      mainWebContents.isDestroyed() ||
      event.sender !== mainWebContents
    ) {
      return
    }
    if (!isNativeFileDropPayload(args)) {
      return
    }

    // Why: one IPC event per drop gesture so the renderer gets the full path batch without timer-based reconstruction.
    mainWindow.webContents.send('terminal:file-drop', args)
  }
  ipcMain.on(channel, relayFileDrop)
  mainWindow.on('closed', () => {
    // Why: macOS keeps the process alive after window close; drop the closure so the destroyed window isn't retained.
    ipcMain.removeListener(channel, relayFileDrop)
  })
}
