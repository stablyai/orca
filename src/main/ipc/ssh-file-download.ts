import { BrowserWindow, dialog, ipcMain } from 'electron'
import { posix } from 'node:path'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'

export type DownloadRemoteFileResult =
  | { success: true; localPath: string }
  | { success: false; cancelled?: boolean; error?: string }

export function registerSshFileDownloadHandlers(): void {
  ipcMain.removeHandler('fs:downloadRemoteFile')
  ipcMain.handle(
    'fs:downloadRemoteFile',
    async (
      event,
      args: { filePath: string; connectionId: string }
    ): Promise<DownloadRemoteFileResult> => {
      const provider = requireSshFilesystemProvider(args.connectionId)
      if (!provider.downloadFileToLocal) {
        return { success: false, error: 'Download is not supported for this connection.' }
      }

      // Why: remote SSH paths are always POSIX, so use posix.basename to seed the
      // local filename regardless of the host platform running Orca.
      const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const dialogOptions = { defaultPath: posix.basename(args.filePath) }
      const { canceled, filePath: localPath } = parent
        ? await dialog.showSaveDialog(parent, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions)

      if (canceled || !localPath) {
        return { success: false, cancelled: true }
      }

      try {
        await provider.downloadFileToLocal(args.filePath, localPath)
        return { success: true, localPath }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to download file'
        }
      }
    }
  )
}
