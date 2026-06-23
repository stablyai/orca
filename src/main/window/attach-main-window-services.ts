/* eslint-disable max-lines -- Why: this file is the central main-window IPC wiring point; splitting it during the mobile release compatibility rebase would increase release risk. */
import { randomUUID } from 'node:crypto'

import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import type { CreateWorktreeResult, WorktreeStartupLaunch } from '../../shared/types'
import { registerRepoHandlers } from '../ipc/repos'
import { registerWorktreeHandlers } from '../ipc/worktrees'
import { registerWorkspaceCleanupHandlers } from '../ipc/workspace-cleanup'
import { getLocalPtyProvider, registerPtyHandlers } from '../ipc/pty'
import { registerDaemonManagementHandlers } from '../ipc/pty-management'
import { registerSshHandlers } from '../ipc/ssh'
import { registerRemoteWorkspaceHandlers } from '../ipc/remote-workspace'
import { browserManager } from '../browser/browser-manager'
import { hasSystemMediaAccess, requestSystemMediaAccess } from '../browser/browser-media-access'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  checkForUpdatesFromMenu,
  downloadUpdate,
  getUpdateStatus,
  quitAndInstall,
  setupAutoUpdater,
  dismissNudge
} from '../updater'
import { scheduleHistoryGc } from '../terminal-history'
import { hydrateLocalPtyRegistryAtBoot } from '../memory/hydrate-local-pty-registry'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { getKnownWorktreeIdsForHistoryGc } from './history-gc-worktree-ids'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult
} from '../../shared/mobile-markdown-document'
import type { RuntimeMobileSessionTabMove } from '../../shared/runtime-types'
import { isNativeFileDropPayload, type NativeFileDropPayload } from '../../shared/native-file-drop'
import { requestMobileMarkdownFromRenderer } from './mobile-markdown-request-relay'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import type { ClaudeAccountSelectionTarget } from '../claude-accounts/runtime-selection'
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'

let appReloadHandlerTokenCounter = 0
let activeAppReloadHandlerToken: number | null = null
let runtimeNotifierTokenCounter = 0
let activeRuntimeNotifierToken: number | null = null

export function attachMainWindowServices(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService,
  getSelectedCodexHomePath?: (target?: CodexAccountSelectionTarget) => string | null,
  prepareClaudeAuth?: (
    target?: ClaudeAccountSelectionTarget
  ) => Promise<ClaudeRuntimeAuthPreparation>,
  options?: {
    awaitLocalPtyStartup?: () => Promise<void>
    onBeforeRendererReload?: (args: { webContentsId: number; ignoreCache: boolean }) => void
    onBeforeUpdateQuit?: () => void | Promise<void>
  }
): void {
  registerAppReloadHandler(mainWindow, options?.onBeforeRendererReload)
  registerRepoHandlers(mainWindow, store)
  registerWorktreeHandlers(mainWindow, store, runtime)
  registerWorkspaceCleanupHandlers(store, { runtime, getLocalPtyProvider })
  registerPtyHandlers(
    mainWindow,
    runtime,
    getSelectedCodexHomePath,
    () => store.getSettings(),
    prepareClaudeAuth,
    store,
    {
      awaitLocalPtyStartup: options?.awaitLocalPtyStartup
    }
  )
  // Why: the Manage Sessions settings panel (docs/daemon-staleness-ux.md §Phase 1)
  // uses a narrow `pty:management:*` IPC surface that reads the live
  // DaemonPtyRouter via getDaemonProvider(). Registering here — after
  // registerPtyHandlers — keeps this wiring alongside the rest of the PTY IPC
  // and ensures the handlers are re-installed on macOS app re-activation when
  // the main window is recreated.
  registerDaemonManagementHandlers()
  // Why: do not enumerate repo paths from background GC. `git worktree list`
  // can re-touch protected folders on macOS and trigger folder-access prompts.
  scheduleHistoryGc(async () => {
    return getKnownWorktreeIdsForHistoryGc(store)
  })
  // Why: warm-reattach gap.
  // Daemon-hosted PTYs survive renderer restarts on purpose, so on a fresh
  // Orca launch the daemon's `listSessions()` returns sessions that
  // `pty:spawn` hasn't re-registered yet. Without this hydration, the
  // memory snapshot omits those PTYs and the renderer mislabels their
  // workspaces as `· REMOTE` while showing `—` for CPU/Memory.
  // `hydrateLocalPtyRegistryAtBoot` is idempotent (no-op after the first
  // call), so calling it on every macOS dock re-activation — when this
  // function re-runs as the main window is recreated — does not redo the
  // git I/O or daemon RPC.
  void hydrateLocalPtyRegistryAtBoot(store)
  const localPtyStartupReady = options?.awaitLocalPtyStartup?.()
  if (localPtyStartupReady) {
    void localPtyStartupReady
      .then(() => hydrateLocalPtyRegistryAtBoot(store))
      .catch((error) => {
        console.warn(
          '[memory] Deferred pty-registry hydration skipped:',
          error instanceof Error ? error.message : String(error)
        )
      })
  }
  registerSshHandlers(store, () => mainWindow, runtime)
  registerRemoteWorkspaceHandlers(store, () => mainWindow)
  registerFileDropRelay(mainWindow)
  setupAutoUpdater(mainWindow, {
    getLastUpdateCheckAt: () => store.getUI().lastUpdateCheckAt,
    onBeforeQuit: async () => {
      try {
        await options?.onBeforeUpdateQuit?.()
      } finally {
        store.flush()
      }
    },
    setLastUpdateCheckAt: (timestamp) => {
      store.updateUI({ lastUpdateCheckAt: timestamp })
    },
    getPendingUpdateNudgeId: () => store.getUI().pendingUpdateNudgeId ?? null,
    getDismissedUpdateNudgeId: () => store.getUI().dismissedUpdateNudgeId ?? null,
    setPendingUpdateNudgeId: (id) => {
      // Why: the nudge lifecycle is owned by the main process. When applying a
      // new campaign, persist the pending id AND clear the version dismissal
      // together so relaunches cannot resurrect the old hidden-card state
      // between nudge apply and renderer sync. When clearing (id is null),
      // only touch pendingUpdateNudgeId — clearing dismissedUpdateVersion here
      // would silently un-dismiss an update if the flow ever changes.
      if (id) {
        store.updateUI({ pendingUpdateNudgeId: id, dismissedUpdateVersion: null })
      } else {
        store.updateUI({ pendingUpdateNudgeId: null })
      }
    },
    setDismissedUpdateNudgeId: (id) => {
      store.updateUI({ dismissedUpdateNudgeId: id })
    }
  })
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
    // Why: browser webviews are renderer-owned guest surfaces. Clearing
    // main-owned guest registrations on window close prevents stale
    // tab→webContents ids from leaking across app relaunch or hot-reload cycles.
    browserManager.unregisterAll()
  })
}

function registerAppReloadHandler(
  mainWindow: BrowserWindow,
  onBeforeRendererReload?: (args: { webContentsId: number; ignoreCache: boolean }) => void
): void {
  // Why: the process-global IPC handler can outlive the BrowserWindow, so keep
  // the registered WebContents and guard both lifetimes before using it.
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
    // Why: macOS can keep the process alive with no window, and this global
    // handler otherwise keeps the closed BrowserWindow reachable until reopen.
    ipcMain.removeHandler('app:reload')
    activeAppReloadHandlerToken = null
  })
}

function registerRuntimeWindowLifecycle(
  mainWindow: BrowserWindow,
  runtime: OrcaRuntimeService
): void {
  const notifierToken = ++runtimeNotifierTokenCounter
  activeRuntimeNotifierToken = notifierToken
  runtime.attachWindow(mainWindow.id)
  const send = (channel: string, ...args: unknown[]): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args)
    }
  }
  runtime.setNotifier({
    worktreesChanged: (repoId, renamed) => {
      // Why: clear detected-worktree scan caches before renderer listeners
      // handle this event, preventing stale TTL reads after mutations.
      runWorktreeChangeInvalidators(repoId)
      send('worktrees:changed', renamed ? { repoId, renamed } : { repoId })
    },
    worktreeBaseStatus: (event) => send('worktree:baseStatus', event),
    worktreeRemoteBranchConflict: (event) => send('worktree:remoteBranchConflict', event),
    reposChanged: () => send('repos:changed'),
    activateWorktree: (
      repoId,
      worktreeId,
      setup?: CreateWorktreeResult['setup'],
      startup?: WorktreeStartupLaunch,
      defaultTabs?: CreateWorktreeResult['defaultTabs']
    ) => {
      send('ui:activateWorktree', {
        repoId,
        worktreeId,
        ...(setup ? { setup } : {}),
        ...(startup ? { startup } : {}),
        ...(defaultTabs ? { defaultTabs } : {})
      })
    },
    createTerminal: (worktreeId, opts) =>
      send('ui:createTerminal', {
        worktreeId,
        command: opts.command,
        ...(opts.env ? { env: opts.env } : {}),
        title: opts.title
      }),
    revealTerminalSession: (worktreeId, opts) =>
      new Promise((resolve, reject) => {
        const requestId = randomUUID()
        const timer = setTimeout(() => {
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          reject(new Error('Terminal reveal timed out'))
        }, 10_000)
        const handler = (
          _event: Electron.IpcMainEvent,
          reply: { requestId: string; tabId?: string; title?: string; error?: string }
        ): void => {
          if (reply.requestId !== requestId) {
            return
          }
          clearTimeout(timer)
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          if (reply.error) {
            reject(new Error(reply.error))
            return
          }
          resolve({ tabId: reply.tabId!, title: reply.title })
        }
        ipcMain.on('terminal:tabCreateReply', handler)
        send('ui:createTerminal', {
          requestId,
          worktreeId,
          ptyId: opts.ptyId,
          title: opts.title ?? undefined,
          ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
          ...(opts.launchToken ? { launchToken: opts.launchToken } : {}),
          ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
          activate: opts.activate !== false,
          // Why: pre-minted tabId from main keeps the renderer's tab id aligned
          // with the paneKey baked into the PTY env at spawn time, so hook
          // events route to the right slot.
          ...(opts.tabId !== undefined ? { tabId: opts.tabId } : {}),
          ...(opts.leafId !== undefined ? { leafId: opts.leafId } : {}),
          ...(opts.splitFromLeafId !== undefined ? { splitFromLeafId: opts.splitFromLeafId } : {}),
          ...(opts.splitDirection !== undefined ? { splitDirection: opts.splitDirection } : {}),
          ...(opts.splitTelemetrySource !== undefined
            ? { splitTelemetrySource: opts.splitTelemetrySource }
            : {})
        })
      }),
    splitTerminal: (tabId, paneRuntimeId, opts) => {
      send('ui:splitTerminal', {
        tabId,
        paneRuntimeId,
        direction: opts.direction,
        command: opts.command,
        telemetrySource: opts.telemetrySource
      })
    },
    renameTerminal: (tabId, title) => send('ui:renameTerminal', { tabId, title }),
    focusTerminal: (tabId, worktreeId, leafId) =>
      send('ui:focusTerminal', { tabId, worktreeId, leafId }),
    focusEditorTab: (tabId, worktreeId) => send('ui:focusEditorTab', { tabId, worktreeId }),
    closeSessionTab: (tabId, worktreeId) => send('ui:closeSessionTab', { tabId, worktreeId }),
    moveSessionTab: (worktreeId: string, move: RuntimeMobileSessionTabMove) =>
      send('ui:moveSessionTab', { worktreeId, ...move }),
    openFile: (worktreeId, filePath, relativePath, runtimeEnvironmentId?) =>
      send('ui:openFileFromMobile', {
        worktreeId,
        filePath,
        relativePath,
        runtimeEnvironmentId
      }),
    openDiff: (worktreeId, filePath, relativePath, staged, runtimeEnvironmentId?) =>
      send('ui:openDiffFromMobile', {
        worktreeId,
        filePath,
        relativePath,
        staged,
        runtimeEnvironmentId
      }),
    readMobileMarkdownTab: (worktreeId, tabId) =>
      requestMobileMarkdownFromRenderer(mainWindow, {
        operation: 'read',
        worktreeId,
        tabId
      }) as Promise<RuntimeMarkdownReadTabResult>,
    saveMobileMarkdownTab: (worktreeId, tabId, baseVersion, content) =>
      requestMobileMarkdownFromRenderer(mainWindow, {
        operation: 'save',
        worktreeId,
        tabId,
        baseVersion,
        content
      }) as Promise<RuntimeMarkdownSaveTabResult>,
    closeTerminal: (tabId, paneRuntimeId) => send('ui:closeTerminal', { tabId, paneRuntimeId }),
    sleepWorktree: (worktreeId) => send('ui:sleepWorktree', { worktreeId }),
    terminalFitOverrideChanged: (ptyId, mode, cols, rows) =>
      send('runtime:terminalFitOverrideChanged', { ptyId, mode, cols, rows }),
    terminalDriverChanged: (ptyId, driver) =>
      send('runtime:terminalDriverChanged', { ptyId, driver }),
    browserDriverChanged: (browserPageId, driver) =>
      send('runtime:browserDriverChanged', { browserPageId, driver })
  })
  // Why: the runtime must fail closed while the renderer graph is being torn
  // down or rebuilt, otherwise future CLI calls could act on stale terminal
  // mappings during reload transitions.
  mainWindow.webContents.on('did-start-loading', () => {
    runtime.markRendererReloading(mainWindow.id)
  })
  mainWindow.on('closed', () => {
    runtime.markGraphUnavailable(mainWindow.id)
    if (activeRuntimeNotifierToken === notifierToken) {
      // Why: the notifier closes over the BrowserWindow for mobile/CLI UI
      // relays; clear it during the no-window gap so the runtime does not
      // retain destroyed window graphs.
      runtime.setNotifier(null)
      activeRuntimeNotifierToken = null
    }
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

    // Why: relay exactly one IPC event per drop gesture so the renderer
    // receives the full batch of paths without timer-based reconstruction.
    mainWindow.webContents.send('terminal:file-drop', args)
  }
  ipcMain.on(channel, relayFileDrop)
  mainWindow.on('closed', () => {
    // Why: macOS can keep the app process alive after the window closes; drop
    // the relay closure so a destroyed BrowserWindow is not retained.
    ipcMain.removeListener(channel, relayFileDrop)
  })
}

export function registerUpdaterHandlers(_store: Store): void {
  ipcMain.removeHandler('updater:getStatus')
  ipcMain.removeHandler('updater:getVersion')
  ipcMain.removeHandler('updater:check')
  ipcMain.removeHandler('updater:download')
  ipcMain.removeHandler('updater:quitAndInstall')
  ipcMain.removeHandler('updater:dismissNudge')

  ipcMain.handle('updater:getStatus', () => getUpdateStatus())
  ipcMain.handle('updater:getVersion', () => app.getVersion())
  ipcMain.handle('updater:check', (_event, options?: { includePrerelease?: boolean }) =>
    checkForUpdatesFromMenu(options)
  )
  ipcMain.handle('updater:download', () => downloadUpdate())
  ipcMain.handle('updater:quitAndInstall', () => quitAndInstall())
  ipcMain.handle('updater:dismissNudge', () => dismissNudge())
}
