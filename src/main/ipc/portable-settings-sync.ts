import { BrowserWindow, ipcMain } from 'electron'
import type { PortableSettingsSyncService } from '../portable-settings-sync-service'
import type { PortableSettingsSyncConfigureArgs } from '../../shared/portable-settings-sync'

const PORTABLE_SETTINGS_SYNC_CHANNELS = [
  'portableSettingsSync:list',
  'portableSettingsSync:configure',
  'portableSettingsSync:pause',
  'portableSettingsSync:stop',
  'portableSettingsSync:syncNow'
] as const

export function registerPortableSettingsSyncHandlers(
  service: PortableSettingsSyncService
): () => void {
  for (const channel of PORTABLE_SETTINGS_SYNC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle('portableSettingsSync:list', () => service.getStates())
  ipcMain.handle(
    'portableSettingsSync:configure',
    (_event, args: PortableSettingsSyncConfigureArgs) => service.configure(args)
  )
  ipcMain.handle('portableSettingsSync:pause', (_event, args: { environmentId: string }) =>
    service.pause(args.environmentId)
  )
  ipcMain.handle('portableSettingsSync:stop', (_event, args: { environmentId: string }) => {
    service.stop(args.environmentId)
  })
  ipcMain.handle('portableSettingsSync:syncNow', (_event, args: { environmentId: string }) =>
    service.syncNow(args.environmentId)
  )

  const unsubscribe = service.onStateChanged((states) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('portableSettingsSync:changed', states)
      }
    }
  })
  return () => {
    unsubscribe()
    for (const channel of PORTABLE_SETTINGS_SYNC_CHANNELS) {
      ipcMain.removeHandler(channel)
    }
  }
}
