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
  type UpdateInstallMode
} from '../updater'

const UPDATER_SETUP_FALLBACK_MS = 15_000

// Why: a manual check can arrive before deferred setup runs, so entry points force this pending setup to configure the updater first.
let pendingAutoUpdaterSetup: (() => void) | null = null

export function ensureAutoUpdaterConfigured(): void {
  pendingAutoUpdaterSetup?.()
}

export function scheduleMainWindowAutoUpdaterSetup(
  mainWindow: BrowserWindow,
  store: Store,
  options?: {
    onBeforeUpdateQuit?: () => void | Promise<void>
    updateInstallMode?: UpdateInstallMode
  }
): void {
  // Why: setupAutoUpdater sync-require()s electron-updater (slow on cold Windows w/ Defender, #7225), so defer past first paint; timer fallback covers crash-looping renderers.
  let updaterSetupDone = false
  const setupAutoUpdaterDeferred = (): void => {
    if (updaterSetupDone || mainWindow.isDestroyed()) {
      return
    }
    updaterSetupDone = true
    setupAutoUpdater(mainWindow, {
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
        // Why: only the apply branch also nulls dismissedUpdateVersion so relaunch can't resurrect the old hidden card; clearing must not, or it un-dismisses.
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
      installMode: options?.updateInstallMode
    })
    logStartupMilestone('updater-setup-done')
  }
  pendingAutoUpdaterSetup = setupAutoUpdaterDeferred
  mainWindow.once('ready-to-show', () => setImmediate(setupAutoUpdaterDeferred))
  const updaterSetupFallback = setTimeout(setupAutoUpdaterDeferred, UPDATER_SETUP_FALLBACK_MS)
  updaterSetupFallback.unref?.()
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
  // Why: the response carries a local package path and the reveal touches the native desktop, so
  // neither may be reached from a guest, dashboard popout, stale window, or utility renderer.
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
    async (_event, channel: ReleaseChannel): Promise<ReleaseBuildListResult> => {
      if (!RELEASE_CHANNELS.includes(channel)) {
        return { ok: false, channel, message: `Unknown release channel "${channel}".` }
      }
      try {
        return { ok: true, channel, builds: await listAvailableReleaseBuilds(channel) }
      } catch (error) {
        // Why: a network/rate-limit failure is expected here; return it as data so
        // the picker can render the reason instead of rejecting the invoke.
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
