/* eslint-disable max-lines -- Why: this file is the central main-window IPC wiring point; splitting it during the mobile release compatibility rebase would increase release risk. */
import { randomUUID } from 'node:crypto'

import { app, ipcMain, session } from 'electron'
import type { BrowserWindow, Session } from 'electron'
import type { Store } from '../persistence'
import type { CreateWorktreeResult, WorktreeStartupLaunch } from '../../shared/types'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import { registerRepoHandlers } from '../ipc/repos'
import { registerWorktreeHandlers } from '../ipc/worktrees'
import { registerWorkspaceCleanupHandlers } from '../ipc/workspace-cleanup'
import { getLocalPtyProvider, registerPtyHandlers } from '../ipc/pty'
import { registerDaemonManagementHandlers } from '../ipc/pty-management'
import { registerSshHandlers } from '../ipc/ssh'
import { registerRemoteWorkspaceHandlers } from '../ipc/remote-workspace'
import { browserManager } from '../browser/browser-manager'
import { hasSystemMediaAccess, requestSystemMediaAccess } from '../browser/browser-media-access'
import {
  allowsBrowserWebAuthnPermission,
  installBrowserWebAuthnAccessHandlers
} from '../browser/browser-webauthn-access'
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
import {
  broadcastToMainWindows,
  getFocusedOrLastActiveMainWindow,
  getMainWindowById,
  getMainWindowForWebContents,
  sendToWindow
} from './main-window-registry'
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'

let onBeforeAppRendererReload:
  | ((args: { webContentsId: number; ignoreCache: boolean }) => void)
  | undefined
const runtimeNotifierWindowIds = new Set<number>()

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
  registerSshHandlers(store, getFocusedOrLastActiveMainWindow, runtime)
  registerRemoteWorkspaceHandlers(store, getFocusedOrLastActiveMainWindow)
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
        store.updateUI({
          pendingUpdateNudgeId: id,
          dismissedUpdateVersion: null
        })
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

  const browserSession = session.fromPartition(ORCA_BROWSER_PARTITION)
  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    // Why: the in-app browser is for dev previews and lightweight browsing, not
    // trusted desktop-app privileges. Denying by default keeps arbitrary sites
    // from silently escalating into camera/mic/notification prompts inside Orca.
    // Why `media` is allowed through: camera/mic are still gated by macOS TCC
    // at the app-process level, so granting here only *permits* Chromium to
    // use whatever the OS has already authorized for Orca. Denying at this
    // layer would make pages inside the in-app browser throw NotAllowedError
    // even after the user granted Camera/Microphone via Settings → Permissions
    // or System Settings — the bug #1273 partially addressed.
    if (permission === 'media') {
      void requestSystemMediaAccess(
        details as Electron.MediaAccessPermissionRequest | undefined
      ).then(
        (granted) => {
          if (!granted) {
            browserManager.notifyPermissionDenied({
              guestWebContentsId: webContents.id,
              permission,
              rawUrl: webContents.getURL()
            })
          }
          callback(granted)
        },
        (error: unknown) => {
          console.error('[permissions] Browser media access failed:', error)
          browserManager.notifyPermissionDenied({
            guestWebContentsId: webContents.id,
            permission,
            rawUrl: webContents.getURL()
          })
          callback(false)
        }
      )
      return
    }
    const allowed = permission === 'fullscreen'
    if (!allowed) {
      browserManager.notifyPermissionDenied({
        guestWebContentsId: webContents.id,
        permission,
        rawUrl: webContents.getURL()
      })
    }
    callback(allowed)
  })
  browserSession.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    if (permission === 'fullscreen') {
      return true
    }
    if (permission === 'media') {
      return hasSystemMediaAccess(details?.mediaType)
    }
    if (allowsBrowserWebAuthnPermission(permission, details)) {
      return true
    }
    return false
  })
  installBrowserWebAuthnAccessHandlers(browserSession)
  browserSession.setDisplayMediaRequestHandler((_request, callback) => {
    // Why: arbitrary sites inside Orca should never be able to capture the
    // desktop or application windows until there is explicit product UX for
    // selecting a source and surfacing that choice to the user.
    // Why: pass undefined (not null) to satisfy Electron's typed callback
    // signature while still denying the request.
    callback({ video: undefined, audio: undefined })
  })
  registerBrowserDownloadHandler(browserSession)

  const rendererWebContentsId = mainWindow.webContents.id
  mainWindow.on('closed', () => {
    // Why: browser webviews are renderer-owned guest surfaces. Clearing
    // only this renderer's registrations prevents one closed window from
    // tearing down browser tabs that still belong to another desktop window.
    // Capture the id while the window is live; Electron may destroy
    // webContents before BrowserWindow emits `closed`.
    browserManager.unregisterGuestsForRenderer(rendererWebContentsId)
  })
}

function handleBrowserWillDownload(
  _event: Electron.Event,
  item: Electron.DownloadItem,
  webContents: Electron.WebContents
): void {
  // Why: browser-tab downloads need explicit product UX before arbitrary sites
  // can write files through Orca. Pause the item and route it through
  // BrowserManager so the user must explicitly accept the save path first.
  browserManager.handleGuestWillDownload({
    guestWebContentsId: webContents.id,
    item
  })
}

function registerBrowserDownloadHandler(browserSession: Session): void {
  // Why: browser sessions are process-persistent while main windows can be
  // recreated; replace the named handler so re-attach does not stack listeners.
  browserSession.removeListener('will-download', handleBrowserWillDownload)
  browserSession.on('will-download', handleBrowserWillDownload)
}

function registerAppReloadHandler(
  _mainWindow: BrowserWindow,
  onBeforeRendererReload?: (args: { webContentsId: number; ignoreCache: boolean }) => void
): void {
  onBeforeAppRendererReload = onBeforeRendererReload
  ipcMain.removeHandler('app:reload')
  ipcMain.handle('app:reload', (event) => {
    const window = getMainWindowForWebContents(event.sender)
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return
    }
    onBeforeAppRendererReload?.({
      webContentsId: window.webContents.id,
      ignoreCache: false
    })
    window.webContents.reload()
  })
}

function registerRuntimeWindowLifecycle(
  mainWindow: BrowserWindow,
  runtime: OrcaRuntimeService
): void {
  runtimeNotifierWindowIds.add(mainWindow.id)
  runtime.attachWindow(mainWindow.id)
  const getWindowByOwnerId = (windowId: number | null): BrowserWindow | null =>
    windowId === null ? null : getMainWindowById(windowId)
  const sendToTarget = (channel: string, ...args: unknown[]): void => {
    const target = getFocusedOrLastActiveMainWindow()
    if (target) {
      sendToWindow(target, channel, ...args)
    }
  }
  const sendToOwner = (ownerWindowId: number | null, channel: string, ...args: unknown[]): void => {
    const target = getWindowByOwnerId(ownerWindowId)
    if (target) {
      sendToWindow(target, channel, ...args)
    }
  }
  const sendToOwnerOrTarget = (
    ownerWindowId: number | null,
    channel: string,
    ...args: unknown[]
  ): void => {
    const target =
      ownerWindowId === null
        ? getFocusedOrLastActiveMainWindow()
        : getWindowByOwnerId(ownerWindowId)
    if (target) {
      sendToWindow(target, channel, ...args)
    }
  }
  const broadcast = (channel: string, ...args: unknown[]): void =>
    broadcastToMainWindows(channel, ...args)
  runtime.setNotifier({
    worktreesChanged: (repoId, renamed) => {
      // Why: clear detected-worktree scan caches before renderer listeners
      // handle this event, preventing stale TTL reads after mutations.
      runWorktreeChangeInvalidators(repoId)
      broadcast('worktrees:changed', renamed ? { repoId, renamed } : { repoId })
    },
    worktreeBaseStatus: (event) => broadcast('worktree:baseStatus', event),
    worktreeRemoteBranchConflict: (event) => broadcast('worktree:remoteBranchConflict', event),
    reposChanged: () => broadcast('repos:changed'),
    activateWorktree: (
      repoId,
      worktreeId,
      setup?: CreateWorktreeResult['setup'],
      startup?: WorktreeStartupLaunch,
      defaultTabs?: CreateWorktreeResult['defaultTabs']
    ) => {
      sendToTarget('ui:activateWorktree', {
        repoId,
        worktreeId,
        ...(setup ? { setup } : {}),
        ...(startup ? { startup } : {}),
        ...(defaultTabs ? { defaultTabs } : {})
      })
    },
    createTerminal: (worktreeId, opts) =>
      sendToTarget('ui:createTerminal', {
        worktreeId,
        command: opts.command,
        ...(opts.env ? { env: opts.env } : {}),
        title: opts.title
      }),
    revealTerminalSession: (worktreeId, opts) =>
      new Promise((resolve, reject) => {
        const ownerWindowId =
          opts.tabId && opts.splitFromLeafId
            ? runtime.resolveOwnerWindowIdForLeaf(opts.tabId, opts.splitFromLeafId)
            : opts.tabId
              ? (runtime.resolveOwnerWindowIdForWorktreeTab(worktreeId, opts.tabId) ??
                runtime.resolveOwnerWindowIdForTabId(opts.tabId))
              : runtime.resolveOwnerWindowIdForPtyId(opts.ptyId)
        const ownerTarget = getWindowByOwnerId(ownerWindowId)
        if (ownerWindowId !== null && !ownerTarget) {
          reject(new Error('runtime_unavailable'))
          return
        }
        const target = ownerTarget ?? getFocusedOrLastActiveMainWindow()
        if (!target) {
          reject(new Error('runtime_unavailable'))
          return
        }
        const requestId = randomUUID()
        const timer = setTimeout(() => {
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          target.removeListener('closed', onTargetClosed)
          reject(new Error('Terminal reveal timed out'))
        }, 10_000)
        const handler = (
          event: Electron.IpcMainEvent,
          reply: {
            requestId: string
            tabId?: string
            title?: string
            error?: string
          }
        ): void => {
          if (event.sender !== target.webContents || reply.requestId !== requestId) {
            return
          }
          clearTimeout(timer)
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          target.removeListener('closed', onTargetClosed)
          if (reply.error) {
            reject(new Error(reply.error))
            return
          }
          resolve({ tabId: reply.tabId!, title: reply.title })
        }
        const onTargetClosed = (): void => {
          clearTimeout(timer)
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          reject(new Error('runtime_unavailable'))
        }
        ipcMain.on('terminal:tabCreateReply', handler)
        target.once('closed', onTargetClosed)
        // Why: runtime-created PTYs can emit daemon output before the renderer
        // publishes its graph, so stamp the chosen window before adoption.
        runtime.registerPtyOwnerWindow(opts.ptyId, target.id)
        sendToWindow(target, 'ui:createTerminal', {
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
      sendToOwner(runtime.resolveOwnerWindowIdForTabId(tabId), 'ui:splitTerminal', {
        tabId,
        paneRuntimeId,
        direction: opts.direction,
        command: opts.command,
        telemetrySource: opts.telemetrySource
      })
    },
    renameTerminal: (tabId, title) =>
      sendToOwner(runtime.resolveOwnerWindowIdForTabId(tabId), 'ui:renameTerminal', {
        tabId,
        title
      }),
    focusTerminal: (tabId, worktreeId, leafId) =>
      sendToOwner(
        leafId
          ? runtime.resolveOwnerWindowIdForLeaf(tabId, leafId)
          : runtime.resolveOwnerWindowIdForWorktreeTab(worktreeId, tabId),
        'ui:focusTerminal',
        { tabId, worktreeId, leafId }
      ),
    focusEditorTab: (tabId, worktreeId) =>
      sendToOwner(
        runtime.resolveOwnerWindowIdForWorktreeTab(worktreeId, tabId),
        'ui:focusEditorTab',
        { tabId, worktreeId }
      ),
    closeSessionTab: (tabId, worktreeId) =>
      sendToOwner(
        runtime.resolveOwnerWindowIdForWorktreeTab(worktreeId, tabId),
        'ui:closeSessionTab',
        { tabId, worktreeId }
      ),
    moveSessionTab: (worktreeId: string, move: RuntimeMobileSessionTabMove) =>
      sendToOwner(
        runtime.resolveOwnerWindowIdForWorktreeTab(worktreeId, move.tabId),
        'ui:moveSessionTab',
        { worktreeId, ...move }
      ),
    openFile: (worktreeId, filePath, relativePath, runtimeEnvironmentId?) =>
      sendToTarget('ui:openFileFromMobile', {
        worktreeId,
        filePath,
        relativePath,
        runtimeEnvironmentId
      }),
    openDiff: (worktreeId, filePath, relativePath, staged, runtimeEnvironmentId?) =>
      sendToTarget('ui:openDiffFromMobile', {
        worktreeId,
        filePath,
        relativePath,
        staged,
        runtimeEnvironmentId
      }),
    readMobileMarkdownTab: (worktreeId, tabId) => {
      const target = getWindowByOwnerId(
        runtime.resolveOwnerWindowIdForWorktreeTab(worktreeId, tabId)
      )
      if (!target) {
        return Promise.reject(new Error('runtime_unavailable'))
      }
      return requestMobileMarkdownFromRenderer(target, {
        operation: 'read',
        worktreeId,
        tabId
      }) as Promise<RuntimeMarkdownReadTabResult>
    },
    saveMobileMarkdownTab: (worktreeId, tabId, baseVersion, content) => {
      const target = getWindowByOwnerId(
        runtime.resolveOwnerWindowIdForWorktreeTab(worktreeId, tabId)
      )
      if (!target) {
        return Promise.reject(new Error('runtime_unavailable'))
      }
      return requestMobileMarkdownFromRenderer(target, {
        operation: 'save',
        worktreeId,
        tabId,
        baseVersion,
        content
      }) as Promise<RuntimeMarkdownSaveTabResult>
    },
    closeTerminal: (tabId, paneRuntimeId) =>
      sendToOwner(runtime.resolveOwnerWindowIdForTabId(tabId), 'ui:closeTerminal', {
        tabId,
        paneRuntimeId
      }),
    sleepWorktree: (worktreeId) => sendToTarget('ui:sleepWorktree', { worktreeId }),
    terminalFitOverrideChanged: (ptyId, mode, cols, rows) =>
      sendToOwnerOrTarget(
        runtime.resolveOwnerWindowIdForPtyId(ptyId),
        'runtime:terminalFitOverrideChanged',
        { ptyId, mode, cols, rows }
      ),
    terminalDriverChanged: (ptyId, driver) =>
      sendToOwnerOrTarget(
        runtime.resolveOwnerWindowIdForPtyId(ptyId),
        'runtime:terminalDriverChanged',
        { ptyId, driver }
      ),
    browserDriverChanged: (browserPageId, driver) =>
      sendToOwnerOrTarget(
        runtime.resolveOwnerWindowIdForBrowserPageId(browserPageId),
        'runtime:browserDriverChanged',
        { browserPageId, driver }
      )
  })
  // Why: the runtime must fail closed while the renderer graph is being torn
  // down or rebuilt, otherwise future CLI calls could act on stale terminal
  // mappings during reload transitions.
  mainWindow.webContents.on('did-start-loading', () => {
    runtime.markRendererReloading(mainWindow.id)
  })
  mainWindow.on('closed', () => {
    runtime.markGraphUnavailable(mainWindow.id)
    runtimeNotifierWindowIds.delete(mainWindow.id)
    if (runtimeNotifierWindowIds.size === 0) {
      // Why: the notifier routes through the live window registry. Keep it
      // installed while any window remains, and clear it during no-window gaps.
      runtime.setNotifier(null)
    }
  })
}

function registerFileDropRelay(_mainWindow: BrowserWindow): void {
  const channel = 'terminal:file-dropped-from-preload'
  ipcMain.removeAllListeners(channel)
  ipcMain.on(channel, (event: Electron.IpcMainEvent, args: NativeFileDropPayload) => {
    const window = getMainWindowForWebContents(event.sender)
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      !isNativeFileDropPayload(args)
    ) {
      return
    }

    // Why: relay exactly one IPC event per drop gesture back to the sender's
    // window so concurrent windows do not receive each other's dropped paths.
    window.webContents.send('terminal:file-drop', args)
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
