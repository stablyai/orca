import { app, clipboard, ipcMain, nativeImage, type IpcMainInvokeEvent } from 'electron'
import { open } from 'node:fs/promises'
import {
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
} from '../../shared/clipboard-image'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import {
  discardClipboardImageTempFile,
  retainClipboardImageTempFile,
  type SaveClipboardImageAsTempFileArgs
} from './clipboard-image-temp-file'
import { readWindowsClipboardImageFileAsPng } from './clipboard-windows-image-file'
import { readClipboardImageSource } from './clipboard-image-source'

export function registerClipboardImagePreviewHandlers({
  assertTrustedSender,
  saveBuffer
}: {
  assertTrustedSender: (event: IpcMainInvokeEvent) => void
  saveBuffer: (buffer: Buffer, args?: SaveClipboardImageAsTempFileArgs) => Promise<string>
}): void {
  ipcMain.handle(
    'clipboard:saveImagePreview',
    async (event, args?: SaveClipboardImageAsTempFileArgs) => {
      assertTrustedSender(event)
      const source = readClipboardImageSource(clipboard)
      if (!source) {
        return null
      }
      const image = clipboard.readImage()
      let buffer: Buffer
      if (image.isEmpty()) {
        if (!source.windowsFileFormats) {
          return null
        }
        const copied = await readWindowsClipboardImageFileAsPng(source.windowsFileFormats, {
          createImageFromBuffer: (bytes) => nativeImage.createFromBuffer(bytes),
          openFile: (filePath) => open(filePath, 'r')
        })
        if (!copied) {
          return null
        }
        buffer = copied
      } else {
        assertClipboardImageDimensionsWithinLimit(image.getSize())
        buffer = image.toPNG()
      }
      assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
      if (args?.runtimeEnvironmentId) {
        const support = await callRuntimeEnvironment(
          app.getPath('userData'),
          args.runtimeEnvironmentId,
          'clipboard.imageLeaseAvailable',
          {},
          15_000
        )
        if (!support.ok) {
          throw new Error('Update the remote Orca server to use image preview')
        }
      }
      const path = await saveBuffer(buffer, { ...args, discardable: true })
      return {
        path,
        dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
        runtimeEnvironmentId: args?.runtimeEnvironmentId ?? null
      }
    }
  )
  ipcMain.handle(
    'clipboard:imageLease',
    async (
      event,
      args: SaveClipboardImageAsTempFileArgs & { path: string; retain?: boolean; release?: boolean }
    ) => {
      assertTrustedSender(event)
      if (args.runtimeEnvironmentId) {
        const response = await callRuntimeEnvironment(
          app.getPath('userData'),
          args.runtimeEnvironmentId,
          'clipboard.imageLease',
          {
            path: args.path,
            connectionId: args.connectionId,
            retain: args.retain,
            release: args.release
          },
          15_000
        )
        if (!response.ok) {
          throw new Error(response.error.message)
        }
      } else if (args.retain) {
        retainClipboardImageTempFile(args.path, args.connectionId ?? null, args.release)
      } else {
        await discardClipboardImageTempFile(args.path, args.connectionId ?? null)
      }
    }
  )
}
