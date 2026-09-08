import { BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { open, writeFile } from 'node:fs/promises'
import { getRuntimePathBasename } from '../../../shared/cross-platform-path'
import { requireSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { sanitizeLocalDownloadFilename } from '../../local-download-filename'
import { registerFilesystemDownloadFolderHandlers } from '../filesystem-download-folder'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import {
  cleanupLocalTransferPath,
  decodeDownloadedFileContent,
  DOWNLOAD_SESSION_TTL_MS,
  inspectDownloadDestination,
  promoteDownloadedFile,
  createSiblingTransferPath,
  type DownloadFileResult
} from './filesystem-download-promotion'

function validateRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`)
  }
  return value
}

export function registerFilesystemDownloadHandlers(context: FilesystemHandlerContext): void {
  const { downloadSessions, closeDownloadSession, cleanupDownloadSessionsForSender } = context

  ipcMain.handle(
    'fs:downloadFile',
    async (
      event,
      args: { filePath?: string; connectionId?: string }
    ): Promise<DownloadFileResult> => {
      const filePath = validateRequiredString(args?.filePath, 'filePath')
      const connectionId = validateRequiredString(args?.connectionId, 'connectionId')
      const provider = requireSshFilesystemProvider(connectionId)
      const remoteStat = await provider.stat(filePath)
      if (remoteStat.type === 'directory') {
        throw new Error('Cannot download a directory')
      }
      if (!provider.downloadFile) {
        throw new Error('Remote file download is unavailable. Reconnect the SSH target and retry.')
      }

      const remoteBasename = getRuntimePathBasename(filePath)
      const defaultPath = sanitizeLocalDownloadFilename(remoteBasename)
      const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const dialogResult = parentWindow
        ? await dialog.showSaveDialog(parentWindow, { defaultPath })
        : await dialog.showSaveDialog({ defaultPath })
      if (dialogResult.canceled || !dialogResult.filePath) {
        return { canceled: true }
      }

      const destinationPath = dialogResult.filePath
      const { existed } = await inspectDownloadDestination(destinationPath)
      const tempPath = createSiblingTransferPath(destinationPath, 'download')
      let promoted = false
      try {
        await provider.downloadFile(filePath, tempPath)
        await promoteDownloadedFile(tempPath, destinationPath, existed)
        promoted = true
        return { canceled: false, destinationPath }
      } finally {
        if (!promoted) {
          await cleanupLocalTransferPath(tempPath)
        }
      }
    }
  )

  registerFilesystemDownloadFolderHandlers()

  ipcMain.handle(
    'fs:saveDownloadedFile',
    async (
      event,
      args: { suggestedName?: string; content?: string; encoding?: 'utf8' | 'base64' }
    ): Promise<DownloadFileResult> => {
      const suggestedName = sanitizeLocalDownloadFilename(
        validateRequiredString(args?.suggestedName, 'suggestedName')
      )
      if (typeof args?.content !== 'string') {
        throw new Error('content is required')
      }
      const content = args.content
      const encoding = args?.encoding === 'base64' ? 'base64' : 'utf8'
      const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const dialogResult = parentWindow
        ? await dialog.showSaveDialog(parentWindow, { defaultPath: suggestedName })
        : await dialog.showSaveDialog({ defaultPath: suggestedName })
      if (dialogResult.canceled || !dialogResult.filePath) {
        return { canceled: true }
      }

      const destinationPath = dialogResult.filePath
      const { existed } = await inspectDownloadDestination(destinationPath)
      const tempPath = createSiblingTransferPath(destinationPath, 'download')
      let promoted = false
      try {
        await writeFile(tempPath, decodeDownloadedFileContent(content, encoding))
        await promoteDownloadedFile(tempPath, destinationPath, existed)
        promoted = true
        return { canceled: false, destinationPath }
      } finally {
        if (!promoted) {
          await cleanupLocalTransferPath(tempPath)
        }
      }
    }
  )

  ipcMain.handle(
    'fs:startDownloadedFile',
    async (
      event,
      args: { suggestedName?: string }
    ): Promise<
      { canceled: true } | { canceled: false; transferId: string; destinationPath: string }
    > => {
      const suggestedName = sanitizeLocalDownloadFilename(
        validateRequiredString(args?.suggestedName, 'suggestedName')
      )
      const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const dialogResult = parentWindow
        ? await dialog.showSaveDialog(parentWindow, { defaultPath: suggestedName })
        : await dialog.showSaveDialog({ defaultPath: suggestedName })
      if (dialogResult.canceled || !dialogResult.filePath) {
        return { canceled: true }
      }

      const destinationPath = dialogResult.filePath
      const { existed } = await inspectDownloadDestination(destinationPath)
      const tempPath = createSiblingTransferPath(destinationPath, 'download')
      const transferId = randomUUID()
      try {
        const handle = await open(tempPath, 'wx')
        const senderId = typeof event.sender.id === 'number' ? event.sender.id : Number.NaN
        const cleanupTimer = setTimeout(() => {
          void closeDownloadSession(transferId, true)
        }, DOWNLOAD_SESSION_TTL_MS)
        if (typeof cleanupTimer.unref === 'function') {
          cleanupTimer.unref()
        }
        downloadSessions.set(transferId, {
          destinationPath,
          tempPath,
          destinationExisted: existed,
          handle,
          cleanupTimer,
          senderId
        })
        event.sender.once?.('destroyed', () => cleanupDownloadSessionsForSender(senderId))
        return { canceled: false, transferId, destinationPath }
      } catch (error) {
        await cleanupLocalTransferPath(tempPath)
        throw error
      }
    }
  )

  ipcMain.handle(
    'fs:appendDownloadedFileChunk',
    async (
      _event,
      args: { transferId?: string; contentBase64?: string }
    ): Promise<{ ok: true }> => {
      const transferId = validateRequiredString(args?.transferId, 'transferId')
      const contentBase64 = validateRequiredString(args?.contentBase64, 'contentBase64')
      const session = downloadSessions.get(transferId)
      if (!session) {
        throw new Error('Download session not found')
      }
      await session.handle.writeFile(Buffer.from(contentBase64, 'base64'))
      return { ok: true }
    }
  )

  ipcMain.handle(
    'fs:finishDownloadedFile',
    async (
      _event,
      args: { transferId?: string }
    ): Promise<{ canceled: false; destinationPath: string }> => {
      const transferId = validateRequiredString(args?.transferId, 'transferId')
      const session = await closeDownloadSession(transferId, false)
      if (!session) {
        throw new Error('Download session not found')
      }
      let promoted = false
      try {
        await promoteDownloadedFile(
          session.tempPath,
          session.destinationPath,
          session.destinationExisted
        )
        promoted = true
        return { canceled: false, destinationPath: session.destinationPath }
      } finally {
        if (!promoted) {
          await cleanupLocalTransferPath(session.tempPath)
        }
      }
    }
  )

  ipcMain.handle(
    'fs:cancelDownloadedFile',
    async (_event, args: { transferId?: string }): Promise<{ ok: true }> => {
      const transferId = validateRequiredString(args?.transferId, 'transferId')
      await closeDownloadSession(transferId, true)
      return { ok: true }
    }
  )
}
