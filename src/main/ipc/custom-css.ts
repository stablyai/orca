import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { CustomCssSnapshot } from '../../shared/custom-css'
import { CustomCssService } from '../custom-css/custom-css-service'
import { authorizeExternalPath } from './filesystem-auth'

export type CustomCssHandlerService = Pick<
  CustomCssService,
  'getSnapshot' | 'ensureFile' | 'dispose'
>

function broadcastCustomCssChanged(snapshot: CustomCssSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('customCss:changed', snapshot)
    }
  }
}

export function createCustomCssService(): CustomCssService {
  return new CustomCssService({
    homePath: app.getPath('home'),
    onChanged: broadcastCustomCssChanged
  })
}

export function registerCustomCssHandlers(
  service: CustomCssHandlerService = createCustomCssService()
): void {
  app.once('will-quit', () => service.dispose())

  ipcMain.handle('customCss:get', () => service.getSnapshot())
  ipcMain.handle('customCss:openFile', async () => {
    const snapshot = service.ensureFile()
    // Why: custom.css is outside any workspace; opening it in Orca's editor still needs fs IPC access.
    authorizeExternalPath(snapshot.path)
    const error = await shell.openPath(snapshot.path)
    if (error) {
      throw new Error(error)
    }
    return snapshot
  })
  ipcMain.handle('customCss:revealFile', () => {
    const snapshot = service.ensureFile()
    authorizeExternalPath(snapshot.path)
    shell.showItemInFolder(snapshot.path)
    return snapshot
  })
}
