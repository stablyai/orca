import { ipcMain, shell } from 'electron'
import {
  finishXcodeSetup,
  resolveInstalledXcodeAppPath,
  useInstalledXcode
} from '../emulator/xcode-setup-actions'

export function registerEmulatorSetupHandlers(): void {
  ipcMain.handle('emulatorSetup:useInstalledXcode', (_event, developerDir: string) =>
    useInstalledXcode(developerDir)
  )
  ipcMain.handle('emulatorSetup:finishXcodeSetup', (_event, developerDir: string) =>
    finishXcodeSetup(developerDir)
  )
  ipcMain.handle('emulatorSetup:openXcode', async (_event, developerDir: string) => {
    try {
      const appPath = await resolveInstalledXcodeAppPath(developerDir)
      const message = await shell.openPath(appPath)
      return { ok: message.length === 0, message: message || undefined }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Could not open Xcode.'
      }
    }
  })
}
