import { app, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type {
  ReleaseBuildListResult,
  UpdateCheckOptions
} from '../../../shared/updater/update-status-types'
import { RELEASE_CHANNELS, type ReleaseChannel } from '../../../shared/updater/release-channel'
import { isTrustedUIRenderer } from '../../ipc/ui'
import { updaterErrorMessage } from './updater-coded-error'
import { updaterCodedMessage } from '../../../shared/updater/updater-failure-copy'
import { getLoadedUpdateStatus, loadUpdaterService } from '../updater-service-slot'
import { ensureAutoUpdaterConfigured } from './main-window-updater'

const UPDATER_IPC_CHANNELS = [
  'updater:getStatus',
  'updater:getVersion',
  'updater:check',
  'updater:download',
  'updater:quitAndInstall',
  'updater:dismissNudge',
  'updater:dismissAvailableUpdate',
  'updater:snoozeRequiredUpdate',
  'updater:getLinuxPackageInstallInstructions',
  'updater:showLinuxPackage',
  'updater:listBuilds'
] as const

export function registerUpdaterHandlers(): void {
  for (const channel of UPDATER_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle('updater:getStatus', () => getLoadedUpdateStatus())
  ipcMain.handle('updater:getVersion', () => app.getVersion())
  ipcMain.handle('updater:check', async (_event, options?: UpdateCheckOptions) => {
    await ensureAutoUpdaterConfigured()
    return (await loadUpdaterService()).checkForUpdatesFromMenu(options)
  })
  ipcMain.handle('updater:download', async () => (await loadUpdaterService()).downloadUpdate())
  ipcMain.handle('updater:quitAndInstall', async () =>
    (await loadUpdaterService()).quitAndInstall()
  )
  ipcMain.handle('updater:dismissNudge', async () => (await loadUpdaterService()).dismissNudge())
  ipcMain.handle('updater:dismissAvailableUpdate', async () =>
    (await loadUpdaterService()).dismissAvailableUpdate()
  )
  ipcMain.handle('updater:snoozeRequiredUpdate', async (event) => {
    assertTrustedUpdaterRecoverySender(event)
    return (await loadUpdaterService()).snoozeRequiredUpdate()
  })
  // Package paths/native reveal belong only to the current trusted main renderer; refuse guests, popouts and stale/utility windows.
  ipcMain.handle('updater:getLinuxPackageInstallInstructions', async (event) => {
    assertTrustedUpdaterRecoverySender(event)
    return (await loadUpdaterService()).getLinuxPackageInstallInstructions()
  })
  ipcMain.handle('updater:showLinuxPackage', async (event) => {
    assertTrustedUpdaterRecoverySender(event)
    return (await loadUpdaterService()).showLinuxPackage()
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
          builds: await (
            await loadUpdaterService()
          ).listAvailableReleaseBuilds(channel, { force: options?.force === true })
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
    throw new Error('Unauthorized updater package recovery sender')
  }
}
