import { BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getRuntimePathBasename } from '../../shared/cross-platform-path'
import { sanitizeLocalDownloadFilename } from '../local-download-filename'
import { promoteLocalDownloadedFolder } from '../local-downloaded-folder-promotion'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { isENOENT } from './filesystem-auth'

type DownloadFolderResult = { canceled: true } | { canceled: false; destinationPath: string }

function validateRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`)
  }
  return value
}

function createSiblingTransferPath(destinationPath: string, suffix: string): string {
  // Why: promotion uses rename/no-clobber operations that must stay on the
  // destination volume, so transfer paths intentionally remain siblings.
  return join(dirname(destinationPath), `.${randomUUID()}.${suffix}`)
}

async function assertDownloadFolderDestinationAvailable(destinationPath: string): Promise<void> {
  try {
    await stat(destinationPath)
  } catch (error) {
    if (isENOENT(error)) {
      return
    }
    throw error
  }
  throw new Error('Destination folder already exists')
}

async function cleanupLocalTransferDirectory(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { recursive: true, force: true })
  } catch (error) {
    // Why: cleanup must not mask the transfer error, but a leaked recursive
    // download tree needs enough visibility to diagnose and remove it.
    console.warn(`[filesystem] Failed to remove temporary folder download '${dirPath}'`, error)
  }
}

// Why: keep folder-download IPC out of filesystem.ts — that module is already large.
export function registerFilesystemDownloadFolderHandlers(): void {
  ipcMain.handle(
    'fs:downloadFolder',
    async (
      event,
      args: { dirPath?: string; connectionId?: string }
    ): Promise<DownloadFolderResult> => {
      const dirPath = validateRequiredString(args?.dirPath, 'dirPath')
      const connectionId = validateRequiredString(args?.connectionId, 'connectionId')
      const provider = requireSshFilesystemProvider(connectionId)
      if (!provider.downloadFolder) {
        throw new Error(
          'Remote folder download is unavailable. Reconnect the SSH target and retry.'
        )
      }
      const abortController = new AbortController()
      const abortOnSenderDestroyed = (): void => {
        abortController.abort(new Error('Folder download canceled because the window closed'))
      }
      event.sender.once('destroyed', abortOnSenderDestroyed)
      if (event.sender.isDestroyed()) {
        abortOnSenderDestroyed()
      }
      try {
        abortController.signal.throwIfAborted()
        const remoteBasename = getRuntimePathBasename(dirPath)
        const destinationBasename = sanitizeLocalDownloadFilename(remoteBasename)
        const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
        // Why: after the local capability/abort checks, open the picker before
        // remote tree validation so SSH latency does not delay click feedback.
        const dialogOptions: Electron.OpenDialogOptions = {
          properties: ['openDirectory', 'createDirectory']
        }
        const dialogResult = parentWindow
          ? await dialog.showOpenDialog(parentWindow, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions)
        const destinationParent = dialogResult.filePaths?.[0]
        if (dialogResult.canceled || !destinationParent) {
          return { canceled: true }
        }
        abortController.signal.throwIfAborted()

        const destinationPath = join(destinationParent, destinationBasename)
        await assertDownloadFolderDestinationAvailable(destinationPath)

        const tempPath = createSiblingTransferPath(destinationPath, 'download')
        try {
          await provider.downloadFolder(dirPath, tempPath, { signal: abortController.signal })
          abortController.signal.throwIfAborted()
          await promoteLocalDownloadedFolder(tempPath, destinationPath, abortController.signal)
          return { canceled: false, destinationPath }
        } finally {
          await cleanupLocalTransferDirectory(tempPath)
        }
      } finally {
        event.sender.removeListener('destroyed', abortOnSenderDestroyed)
      }
    }
  )
}
