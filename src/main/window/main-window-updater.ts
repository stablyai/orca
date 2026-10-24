import { app, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { ReleaseBuildListResult, UpdateCheckOptions } from '../../shared/update-status-types'
import { RELEASE_CHANNELS, type ReleaseChannel } from '../../shared/release-channel'
import { isTrustedUIRenderer } from '../ipc/ui'
import type { Store } from '../persistence'
import { logStartupMilestone } from '../startup/startup-diagnostics'
import {
  checkForUpdatesFromMenu,
  dismissAvailableUpdate,
  dismissNudge,
  downloadUpdate,
  getLinuxPackageInstallInstructions,
  getUpdateStatus,
  listAvailableReleaseBuilds,
  quitAndInstall,
  setupAutoUpdater,
  showLinuxPackage,
  type PreQuitCleanupFailureMode,
  type UpdateInstallMode,
  type UpdaterSetupOptions
} from '../updater'

const UPDATER_SETUP_FALLBACK_MS = 15_000

// Manual checks may precede deferred setup; entry points must configure first.
let pendingAutoUpdaterSetup: (() => void) | null = null

export function ensureAutoUpdaterConfigured(): void {
  pendingAutoUpdaterSetup?.()
}

type UpdaterSetupHooks = {
  onBeforeUpdateQuit?: () => void | Promise<void>
  onBeforeUpdateQuitFailure?: PreQuitCleanupFailureMode
  updateInstallMode?: UpdateInstallMode
}

function buildUpdaterSetupOptions(store: Store, options?: UpdaterSetupHooks): UpdaterSetupOptions {
  return {
    getLastUpdateCheckAt: () => store.getUI().lastUpdateCheckAt,
    onBeforeQuit: async () => {
      try {
        await options?.onBeforeUpdateQuit?.()
      } finally {
        await store.flushPendingAsync()
      }
    },
    setLastUpdateCheckAt: (timestamp) => {
      store.updateUI({ lastUpdateCheckAt: timestamp })
    },
    getPendingUpdateNudgeId: () => store.getUI().pendingUpdateNudgeId ?? null,
    getDismissedUpdateNudgeId: () => store.getUI().dismissedUpdateNudgeId ?? null,
    setPendingUpdateNudgeId: (id) => {
      // Applying a new campaign clears the hidden card; clearing a campaign must preserve dismissal.
      if (id) {
        store.updateUI({ pendingUpdateNudgeId: id, dismissedUpdateVersion: null })
      } else {
        store.updateUI({ pendingUpdateNudgeId: null })
      }
    },
    setDismissedUpdateNudgeId: (id) => {
      store.updateUI({ dismissedUpdateNudgeId: id })
    },
    getReleaseChannelOverride: () => store.getUI().releaseChannelOverride ?? null,
    onBeforeQuitFailure: options?.onBeforeUpdateQuitFailure,
    installMode: options?.updateInstallMode
  }
}

/** Headless serve has no window-driven setup; defer the slow require past readiness so remote updater support becomes available (#22261). */
export function setupHeadlessServeAutoUpdater(store: Store, options: UpdaterSetupHooks): void {
  setImmediate(() => {
    try {
      setupAutoUpdater(null, buildUpdaterSetupOptions(store, options))
      logStartupMilestone('updater-setup-done')
    } catch (error) {
      console.warn(
        '[serve] updater setup failed:',
        error instanceof Error ? error.message : String(error)
      )
    }
  })
}

export function scheduleMainWindowAutoUpdaterSetup(
  mainWindow: BrowserWindow,
  store: Store,
  options?: UpdaterSetupHooks
): void {
  // Cold Windows/Defender makes electron-updater require slow (#7225); defer past paint, with a timer for crash-looping renderers.
  let updaterSetupDone = false
  let updaterSetupFallback: ReturnType<typeof setTimeout> | null = null
  const clearDeferredSetup = (): void => {
    if (updaterSetupFallback) {
      clearTimeout(updaterSetupFallback)
      updaterSetupFallback = null
    }
    if (pendingAutoUpdaterSetup === setupAutoUpdaterDeferred) {
      pendingAutoUpdaterSetup = null
    }
  }
  const setupAutoUpdaterDeferred = (): void => {
    if (updaterSetupDone || mainWindow.isDestroyed()) {
      return
    }
    updaterSetupDone = true
    try {
      setupAutoUpdater(mainWindow, buildUpdaterSetupOptions(store, options))
      logStartupMilestone('updater-setup-done')
    } finally {
      clearDeferredSetup()
    }
  }
  pendingAutoUpdaterSetup = setupAutoUpdaterDeferred
  mainWindow.once('ready-to-show', () => setImmediate(setupAutoUpdaterDeferred))
  updaterSetupFallback = setTimeout(() => {
    updaterSetupFallback = null
    setupAutoUpdaterDeferred()
  }, UPDATER_SETUP_FALLBACK_MS)
  updaterSetupFallback.unref?.()
  if (updaterSetupDone) {
    clearDeferredSetup()
  }
}

export function registerUpdaterHandlers(_store: Store): void {
  ipcMain.removeHandler('updater:getStatus')
  ipcMain.removeHandler('updater:getVersion')
  ipcMain.removeHandler('updater:check')
  ipcMain.removeHandler('updater:download')
  ipcMain.removeHandler('updater:quitAndInstall')
  ipcMain.removeHandler('updater:dismissNudge')
  ipcMain.removeHandler('updater:dismissAvailableUpdate')
  ipcMain.removeHandler('updater:getLinuxPackageInstallInstructions')
  ipcMain.removeHandler('updater:showLinuxPackage')
  ipcMain.removeHandler('updater:listBuilds')

  ipcMain.handle('updater:getStatus', () => getUpdateStatus())
  ipcMain.handle('updater:getVersion', () => app.getVersion())
  ipcMain.handle('updater:check', (_event, options?: UpdateCheckOptions) => {
    ensureAutoUpdaterConfigured()
    return checkForUpdatesFromMenu(options)
  })
  ipcMain.handle('updater:download', () => downloadUpdate())
  ipcMain.handle('updater:quitAndInstall', () => quitAndInstall())
  ipcMain.handle('updater:dismissNudge', () => dismissNudge())
  ipcMain.handle('updater:dismissAvailableUpdate', () => dismissAvailableUpdate())
  // Package paths/native reveal belong only to the current trusted main renderer; refuse guests, popouts and stale/utility windows.
  ipcMain.handle('updater:getLinuxPackageInstallInstructions', (event) => {
    assertTrustedUpdaterRecoverySender(event)
    return getLinuxPackageInstallInstructions()
  })
  ipcMain.handle('updater:showLinuxPackage', (event) => {
    assertTrustedUpdaterRecoverySender(event)
    return showLinuxPackage()
  })
  ipcMain.handle(
    'updater:listBuilds',
    async (
      _event,
      channel: ReleaseChannel,
      options?: { force?: boolean }
    ): Promise<ReleaseBuildListResult> => {
      if (!RELEASE_CHANNELS.includes(channel)) {
        return { ok: false, channel, message: `Unknown release channel "${channel}".` }
      }
      try {
        return {
          ok: true,
          channel,
          builds: await listAvailableReleaseBuilds(channel, { force: options?.force === true })
        }
      } catch (error) {
        // Return expected network/rate-limit failures as data for the build picker.
        return { ok: false, channel, message: String((error as Error)?.message ?? error) }
      }
    }
  )
}

function assertTrustedUpdaterRecoverySender(event: IpcMainInvokeEvent): void {
  if (!isTrustedUIRenderer(event.sender)) {
    throw new Error('Unauthorized updater package recovery sender')
  }
}
