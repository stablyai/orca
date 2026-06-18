import {
  clipboard,
  ipcMain,
  nativeImage,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import {
  assertClipboardTextWriteWithinLimitWithYield,
  assertClipboardTextWithinLimitWithYield,
  type ReadClipboardTextOptions
} from '../../shared/clipboard-text'
import {
  saveClipboardImageBufferAsTempFile,
  type SaveClipboardImageAsTempFileArgs
} from './clipboard-image-temp-file'
import {
  assertClipboardImageBase64LengthWithinLimit,
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
} from '../../shared/clipboard-image'

let trustedClipboardRendererWebContentsId: number | null = null

export function setTrustedClipboardRendererWebContentsId(webContentsId: number | null): void {
  trustedClipboardRendererWebContentsId = webContentsId
}

export function registerClipboardHandlers(): void {
  ipcMain.removeHandler('clipboard:readText')
  ipcMain.removeHandler('clipboard:readSelectionText')
  ipcMain.removeHandler('clipboard:writeText')
  ipcMain.removeHandler('clipboard:writeSelectionText')
  ipcMain.removeHandler('clipboard:writeImage')
  ipcMain.removeHandler('clipboard:saveImageAsTempFile')

  ipcMain.handle('clipboard:readText', async (event, options?: ReadClipboardTextOptions) => {
    assertTrustedClipboardSender(event)
    return assertClipboardTextWithinLimitWithYield(clipboard.readText(), options)
  })
  ipcMain.handle(
    'clipboard:readSelectionText',
    async (event, options?: ReadClipboardTextOptions) => {
      assertTrustedClipboardSender(event)
      return assertClipboardTextWithinLimitWithYield(clipboard.readText('selection'), options)
    }
  )
  // Why: terminals need to detect clipboard images to support tools like Claude
  // Code that accept image input via paste. Writes the clipboard image to a
  // temp file and returns the path, or null if the clipboard has no image.
  ipcMain.handle(
    'clipboard:saveImageAsTempFile',
    async (event, args?: SaveClipboardImageAsTempFileArgs) => {
      assertTrustedClipboardSender(event)
      const image = clipboard.readImage()
      if (image.isEmpty()) {
        return null
      }
      assertClipboardImageDimensionsWithinLimit(image.getSize())
      return saveClipboardImageBufferAsTempFile(image.toPNG(), args)
    }
  )
  ipcMain.handle('clipboard:writeText', async (event, text: string) => {
    assertTrustedClipboardSender(event)
    return clipboard.writeText(await assertClipboardTextWriteWithinLimitWithYield(text))
  })
  ipcMain.handle('clipboard:writeSelectionText', async (event, text: string) => {
    assertTrustedClipboardSender(event)
    return clipboard.writeText(
      await assertClipboardTextWriteWithinLimitWithYield(text),
      'selection'
    )
  })
  ipcMain.handle('clipboard:writeImage', (event, dataUrl: string) => {
    assertTrustedClipboardSender(event)
    // Why: only accept validated PNG data URIs to prevent writing arbitrary
    // data to the clipboard. The renderer already validates the prefix, but
    // defense-in-depth applies here too.
    const prefix = 'data:image/png;base64,'
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
      return
    }
    const contentBase64 = dataUrl.slice(prefix.length)
    try {
      assertClipboardImageBase64LengthWithinLimit(contentBase64.length)
    } catch {
      return
    }
    // Why: use createFromBuffer instead of createFromDataURL — the latter
    // silently returns an empty image on some macOS + Electron combinations
    // when the data URL is large (>500KB). Decoding the base64 manually and
    // using createFromBuffer is more reliable.
    const buffer = Buffer.from(contentBase64, 'base64')
    try {
      assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
    } catch {
      return
    }
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) {
      return
    }
    try {
      assertClipboardImageDimensionsWithinLimit(image.getSize())
    } catch {
      return
    }
    clipboard.writeImage(image)
  })
}

function assertTrustedClipboardSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedClipboardRenderer(event.sender)) {
    throw new Error('Unauthorized clipboard IPC sender')
  }
}

function isTrustedClipboardRenderer(sender: WebContents): boolean {
  if (sender.isDestroyed() || sender.getType() !== 'window') {
    return false
  }
  if (trustedClipboardRendererWebContentsId != null) {
    return sender.id === trustedClipboardRendererWebContentsId
  }

  const senderUrl = sender.getURL()
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      return new URL(senderUrl).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    } catch {
      return false
    }
  }

  return senderUrl.startsWith('file://')
}
