import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { app, clipboard, ipcMain, nativeImage } from 'electron'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'

type SaveClipboardImageAsTempFileArgs = {
  connectionId?: string | null
}

const REMOTE_CLIPBOARD_IMAGE_TEMP_DIR = '/tmp'

function joinRemotePath(basePath: string, fileName: string): string {
  if (isWindowsAbsolutePathLike(basePath)) {
    return path.win32.join(basePath, fileName)
  }
  return path.posix.join(basePath, fileName)
}

async function saveClipboardImageBufferAsTempFile(
  buffer: Buffer,
  args?: SaveClipboardImageAsTempFileArgs
): Promise<string> {
  const fileName = `orca-paste-${Date.now()}-${randomUUID()}.png`

  if (args?.connectionId) {
    const provider = requireSshFilesystemProvider(args.connectionId)
    const remoteTempDir = (await provider.getTempDir?.()) ?? REMOTE_CLIPBOARD_IMAGE_TEMP_DIR
    const remotePath = joinRemotePath(remoteTempDir, fileName)
    // Why: SSH terminal agents run on the remote host, so the pasted path must
    // name a remote file. The provider's base64 path writes binary bytes via SFTP.
    await provider.writeFileBase64(remotePath, buffer.toString('base64'))
    return remotePath
  }

  const tempPath = path.join(app.getPath('temp'), fileName)
  await fs.writeFile(tempPath, buffer)
  return tempPath
}

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
  ipcMain.handle(
    'clipboard:saveImageAsTempFile',
    async (_event, args?: SaveClipboardImageAsTempFileArgs) => {
      const image = clipboard.readImage()
      if (image.isEmpty()) {
        return null
      }
      return saveClipboardImageBufferAsTempFile(image.toPNG(), args)
    }
  )
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
