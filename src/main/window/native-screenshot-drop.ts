import { ipcMain, nativeImage, type IpcMainInvokeEvent } from 'electron'
import {
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
} from '../../shared/clipboard-image'
import { saveClipboardImageBufferAsTempFile } from './clipboard-image-temp-file'

export function registerNativeScreenshotDropHandler(
  assertTrustedSender: (event: IpcMainInvokeEvent) => void
): void {
  const channel = 'terminal:saveDroppedScreenshot'
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (event, bytes: unknown) => {
    assertTrustedSender(event)
    if (process.platform !== 'darwin' || !(bytes instanceof Uint8Array)) {
      throw new Error('Invalid dropped screenshot')
    }
    assertClipboardImageByteLengthWithinLimit(bytes.byteLength)
    const image = nativeImage.createFromBuffer(Buffer.from(bytes))
    if (image.isEmpty()) {
      throw new Error('Invalid dropped screenshot')
    }
    assertClipboardImageDimensionsWithinLimit(image.getSize())
    return saveClipboardImageBufferAsTempFile(image.toPNG())
  })
}
