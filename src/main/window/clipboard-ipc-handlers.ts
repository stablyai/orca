import fs from 'node:fs/promises'
import path from 'node:path'

import { app, clipboard, ipcMain, nativeImage } from 'electron'

export function registerClipboardHandlers(): void {
  ipcMain.removeHandler('clipboard:readText')
  ipcMain.removeHandler('clipboard:readSelectionText')
  ipcMain.removeHandler('clipboard:writeText')
  ipcMain.removeHandler('clipboard:writeSelectionText')
  ipcMain.removeHandler('clipboard:writeImage')
  ipcMain.removeHandler('clipboard:saveImageAsTempFile')

  ipcMain.handle('clipboard:readText', () => clipboard.readText())
  ipcMain.handle('clipboard:readSelectionText', () => clipboard.readText('selection'))
  // Why: terminals need to detect clipboard images to support tools like Claude
  // Code that accept image input via paste. Writes the clipboard image to a
  // temp file and returns the path, or null if the clipboard has no image.
  ipcMain.handle('clipboard:saveImageAsTempFile', async () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) {
      return null
    }
    const tempPath = path.join(app.getPath('temp'), `orca-paste-${Date.now()}.png`)
    await fs.writeFile(tempPath, image.toPNG())
    return tempPath
  })
  ipcMain.handle('clipboard:writeText', (_event, text: string) => clipboard.writeText(text))
  ipcMain.handle('clipboard:writeSelectionText', (_event, text: string) =>
    clipboard.writeText(text, 'selection')
  )
  ipcMain.handle('clipboard:writeImage', (_event, dataUrl: string) => {
    // Why: only accept validated PNG data URIs to prevent writing arbitrary
    // data to the clipboard. The renderer already validates the prefix, but
    // defense-in-depth applies here too.
    const prefix = 'data:image/png;base64,'
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
      return
    }
    // Why: use createFromBuffer instead of createFromDataURL — the latter
    // silently returns an empty image on some macOS + Electron combinations
    // when the data URL is large (>500KB). Decoding the base64 manually and
    // using createFromBuffer is more reliable.
    const buffer = Buffer.from(dataUrl.slice(prefix.length), 'base64')
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) {
      return
    }
    clipboard.writeImage(image)
  })
}
