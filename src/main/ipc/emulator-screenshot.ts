import { BrowserWindow, dialog, ipcMain, nativeImage } from 'electron'
import { writeFile } from 'node:fs/promises'

export type SaveEmulatorScreenshotResult =
  | { canceled: true }
  | { canceled: false; destinationPath: string }

type SaveEmulatorScreenshotArgs = {
  bytes: ArrayBuffer
  deviceName?: string
}

function sanitizeFilenameSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || 'mobile-emulator'
}

function timestampForFilename(date = new Date()): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[:T]/g, '-')
}

export function buildEmulatorScreenshotDefaultPath(deviceName?: string, date = new Date()): string {
  const device = sanitizeFilenameSegment(deviceName || 'mobile-emulator')
  return `orca-${device}-${timestampForFilename(date)}.png`
}

function bufferFromArrayBuffer(bytes: ArrayBuffer): Buffer {
  return Buffer.from(new Uint8Array(bytes))
}

export function encodeEmulatorScreenshotPng(bytes: ArrayBuffer): Buffer {
  const image = nativeImage.createFromBuffer(bufferFromArrayBuffer(bytes))
  if (image.isEmpty()) {
    throw new Error('Emulator screenshot frame is not a valid image.')
  }
  return image.toPNG()
}

export function registerEmulatorScreenshotHandlers(): void {
  ipcMain.handle(
    'emulator:saveScreenshot',
    async (event, args: SaveEmulatorScreenshotArgs): Promise<SaveEmulatorScreenshotResult> => {
      if (!(args?.bytes instanceof ArrayBuffer) || args.bytes.byteLength === 0) {
        throw new Error('Emulator screenshot frame is empty.')
      }

      const pngBuffer = encodeEmulatorScreenshotPng(args.bytes)
      const defaultPath = buildEmulatorScreenshotDefaultPath(args.deviceName)
      const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const dialogOptions = {
        defaultPath,
        filters: [{ name: 'PNG Image', extensions: ['png'] }]
      }
      const result = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions)
      if (result.canceled || !result.filePath) {
        return { canceled: true }
      }

      await writeFile(result.filePath, pngBuffer)
      return { canceled: false, destinationPath: result.filePath }
    }
  )
}
