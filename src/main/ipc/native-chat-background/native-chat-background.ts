import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import { translateMain } from '../../i18n/main-i18n'
import { isENOENT } from '../../filesystem/local-file-io/filesystem-path-containment'
import { isNativeChatBackgroundFileName } from '../../../shared/native-chat/settings/native-chat-appearance-settings'

const MAX_BACKGROUND_BYTES = 32 * 1024 * 1024

const BACKGROUND_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

function backgroundsDir(): string {
  return join(app.getPath('userData'), 'native-chat-backgrounds')
}

function backgroundPath(fileName: unknown): string {
  if (!isNativeChatBackgroundFileName(fileName)) {
    throw new Error('Invalid chat background file name')
  }
  return join(backgroundsDir(), fileName)
}

export function registerNativeChatBackgroundHandlers(): void {
  ipcMain.handle('nativeChatBackground:import', async (event): Promise<string | null> => {
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [
        {
          name: translateMain('native.dialog.images', 'Images'),
          extensions: Object.keys(BACKGROUND_MIME_TYPES).map((ext) => ext.slice(1))
        }
      ]
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    const source = result.filePaths[0]
    const ext = extname(source).toLowerCase()
    if (!BACKGROUND_MIME_TYPES[ext]) {
      throw new Error('Unsupported chat background image type')
    }
    const sourceStat = await stat(source)
    if (!sourceStat.isFile()) {
      throw new Error('Chat background is not a file')
    }
    if (sourceStat.size > MAX_BACKGROUND_BYTES) {
      throw new Error('Chat background image is larger than 32 MB')
    }
    await mkdir(backgroundsDir(), { recursive: true })
    const fileName = `${randomUUID()}${ext}`
    await copyFile(source, backgroundPath(fileName))
    return fileName
  })

  ipcMain.handle(
    'nativeChatBackground:read',
    async (_event, fileName: unknown): Promise<{ bytes: ArrayBuffer; mimeType: string } | null> => {
      const path = backgroundPath(fileName)
      try {
        const buffer = await readFile(path)
        return {
          bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          mimeType: BACKGROUND_MIME_TYPES[extname(path).toLowerCase()]
        }
      } catch (error) {
        // A setting synced from another computer names a file this one never had.
        if (isENOENT(error)) {
          return null
        }
        throw error
      }
    }
  )

  ipcMain.handle('nativeChatBackground:delete', async (_event, fileName: unknown) => {
    await rm(backgroundPath(fileName), { force: true })
  })
}
