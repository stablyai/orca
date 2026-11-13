import { app, ipcMain } from 'electron'
import { ToknSyncService } from '../tokn/tokn-sync-service'
import type { ToknUsageReader } from '../tokn/tokn-upload-body'

export function registerToknHandlers(usage: ToknUsageReader): void {
  const service = new ToknSyncService(usage)
  ipcMain.handle('tokn:getStatus', () => service.getStatus())
  ipcMain.handle('tokn:connect', () => service.connect())
  ipcMain.handle('tokn:cancelConnect', () => service.cancelConnect())
  ipcMain.handle('tokn:disconnect', () => service.disconnect())
  ipcMain.handle('tokn:syncNow', () => service.syncNow())
  ipcMain.handle('tokn:previewUpload', () => service.previewUpload())
  service.start()
  app.once('will-quit', () => service.stop())
}
