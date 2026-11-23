import { app, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type {
  ReleaseBuildListResult,
  UpdateCheckOptions
} from '../../../shared/updater/update-status-types'
import { RELEASE_CHANNELS, type ReleaseChannel } from '../../../shared/updater/release-channel'
import { getTrustedUIRendererWindow, isTrustedUIRenderer } from '../../ipc/ui'
import type { NativeSettingsProjection } from '../../core-desktop/native-settings-projection'
import { logStartupMilestone } from '../../startup/diagnostics/startup-diagnostics'
import { applyProxyToElectronUpdaterSession } from './electron-updater-proxy-session'
import { updaterErrorMessage } from './updater-coded-error'
import { updaterCodedMessage } from '../../../shared/updater/updater-failure-copy'
import { normalizeUpdateDelayDays } from '../../../shared/updater/update-delay'
import {
  checkForUpdatesFromMenu,
  dismissAvailableUpdate,
  dismissNudge,
  downloadUpdate,
  getLinuxPackageInstallInstructions,
  getUpdateStatus,
  listAvailableReleaseBuilds,
  quitAndInstall,
  quitToInstallStagedUpdate,
  setupAutoUpdater,
  showLinuxPackage
} from '../updater-service'
import type { PreQuitCleanupFailureMode, UpdateInstallMode } from './updater-state'
import type { UpdaterSetupOptions } from './updater-setup'

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

function buildUpdaterSetupOptions(
  nativeSettings: NativeSettingsProjection,
  options?: UpdaterSetupHooks
): UpdaterSetupOptions {
  return {
    getMainWindow: getTrustedUIRendererWindow,
    getLastUpdateCheckAt: () => nativeSettings.getUI().lastUpdateCheckAt,
    onBeforeQuit: async () => {
      try {
        await options?.onBeforeUpdateQuit?.()
      } finally {
        await nativeSettings.requestCoreWrite({ kind: 'flush-pending' })
      }
    },
    setLastUpdateCheckAt: (timestamp) => {
      void nativeSettings.requestCoreWrite({
        kind: 'ui',
        updates: { lastUpdateCheckAt: timestamp }
      })
    },
    getPendingUpdateNudgeId: () => nativeSettings.getUI().pendingUpdateNudgeId ?? null,
    getDismissedUpdateNudgeId: () => nativeSettings.getUI().dismissedUpdateNudgeId ?? null,
    setPendingUpdateNudgeId: (id) => {
      // Applying a new campaign clears the hidden card; clearing a campaign must preserve dismissal.
      if (id) {
        void nativeSettings.requestCoreWrite({
          kind: 'ui',
          updates: { pendingUpdateNudgeId: id, dismissedUpdateVersion: null }
        })
      } else {
        void nativeSettings.requestCoreWrite({
          kind: 'ui',
          updates: { pendingUpdateNudgeId: null }
        })
      }
    },
    setDismissedUpdateNudgeId: (id) => {
      void nativeSettings.requestCoreWrite({ kind: 'ui', updates: { dismissedUpdateNudgeId: id } })
    },
    getReleaseChannelOverride: () => nativeSettings.getUI().releaseChannelOverride ?? null,
    getUpdateDelayDays: () =>
      normalizeUpdateDelayDays(nativeSettings.getSettings().updateDelayDays),
    getAutomaticUpdates: () => nativeSettings.getSettings().automaticUpdates === true,
    onBeforeQuitFailure: options?.onBeforeUpdateQuitFailure,
    installMode: options?.updateInstallMode
  }
}

function setupAutoUpdaterWithAppProxy(
  mainWindow: BrowserWindow | null,
  nativeSettings: NativeSettingsProjection,
  options?: UpdaterSetupHooks
): void {
  // Starts synchronously, so the session request guard holds the first update check until it settles.
  void applyProxyToElectronUpdaterSession(nativeSettings.getSettings())
  setupAutoUpdater(mainWindow, buildUpdaterSetupOptions(nativeSettings, options))
}

/** Headless serve has no window-driven setup; defer the slow require past readiness so remote updater support becomes available (#22261). */
export function setupHeadlessServeAutoUpdater(
  nativeSettings: NativeSettingsProjection,
  options: UpdaterSetupHooks
): void {
  setImmediate(() => {
    try {
      setupAutoUpdaterWithAppProxy(null, nativeSettings, options)
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
  nativeSettings: NativeSettingsProjection,
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
      setupAutoUpdaterWithAppProxy(mainWindow, nativeSettings, options)
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

export function registerUpdaterHandlers(): void {
  ipcMain.removeHandler('updater:getStatus')
  ipcMain.removeHandler('updater:getVersion')
  ipcMain.removeHandler('updater:check')
  ipcMain.removeHandler('updater:download')
  ipcMain.removeHandler('updater:quitAndInstall')
  ipcMain.removeHandler('updater:quitToInstallStagedUpdate')
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
  ipcMain.handle('updater:quitToInstallStagedUpdate', (event, version: string) => {
    assertTrustedUpdaterRecoverySender(event)
    quitToInstallStagedUpdate(version)
  })
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
        return { ok: false, channel, ...updaterCodedMessage('unknownReleaseChannel', { channel }) }
      }
      try {
        return {
          ok: true,
          channel,
          builds: await listAvailableReleaseBuilds(channel, { force: options?.force === true })
        }
      } catch (error) {
        // Return expected network/rate-limit failures as data for the build picker.
        return { ok: false, channel, ...updaterErrorMessage(error) }
      }
    }
  )
}

function assertTrustedUpdaterRecoverySender(event: IpcMainInvokeEvent): void {
  if (!isTrustedUIRenderer(event.sender)) {
    throw new Error('Unauthorized updater recovery sender')
  }
}
