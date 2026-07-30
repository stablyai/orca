import { dialog, ipcMain } from 'electron'
import { basename, extname } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { MAX_REPO_ICON_UPLOAD_BYTES } from '../../shared/repo-icon'

const REPO_ICON_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png'
}

/**
 * Register all file/folder picker dialog IPC handlers.
 * Extracted from shell.ts to keep the file under the max-lines limit.
 */
export function registerShellPickerHandlers(): void {
  // Why: window.prompt() and <input type="file"> are unreliable in Electron,
  // so we use the native OS dialog to let the user pick any attachment file.
  ipcMain.handle('shell:pickAttachment', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // Why: multi-select variant of pickAttachment so users can select several
  // files at once instead of repeating the picker for each file.
  ipcMain.handle('shell:pickAttachments', async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return []
    }
    return result.filePaths
  })

  // Why: window.prompt() and <input type="file"> are unreliable in Electron,
  // so we use the native OS dialog to let the user pick an image file.
  ipcMain.handle('shell:pickImage', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // Why: multi-select variant of pickImage so users can insert several images
  // into a Markdown document at once instead of picking them one by one.
  ipcMain.handle('shell:pickImages', async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return []
    }
    return result.filePaths
  })

  ipcMain.handle('shell:pickAudio', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'flac'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // Why: multi-select variant of pickAudio so users can pick several audio
  // files in one dialog instead of repeating the picker for each file.
  ipcMain.handle('shell:pickAudios', async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'flac'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return []
    }
    return result.filePaths
  })

  ipcMain.handle(
    'shell:pickDirectory',
    async (_event, args: { defaultPath?: string }): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        defaultPath: args.defaultPath,
        // Why: callers only need an existing folder grant; enabling native
        // creation can leave typed prefix directories behind on macOS.
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      return result.filePaths[0]
    }
  )

  ipcMain.handle(
    'shell:pickRepoIconImage',
    async (): Promise<{ dataUrl: string; fileName: string } | null> => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Repo icon images', extensions: ['png'] }]
      })
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }

      const filePath = result.filePaths[0]
      const extension = extname(filePath).toLowerCase()
      const mimeType = REPO_ICON_IMAGE_MIME_TYPES[extension]
      if (!mimeType) {
        throw new Error('Repo icons must be PNG files.')
      }

      const stats = await stat(filePath)
      if (stats.size > MAX_REPO_ICON_UPLOAD_BYTES) {
        throw new Error('Repo icon image must be 256KB or smaller.')
      }

      const buffer = await readFile(filePath)
      return {
        dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
        fileName: basename(filePath)
      }
    }
  )
}
