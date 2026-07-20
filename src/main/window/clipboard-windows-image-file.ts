import { extname, win32 } from 'node:path'
import type { NativeImage } from 'electron'
import {
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
} from '../../shared/clipboard-image'
import { IMAGE_FILE_EXTENSIONS } from '../../shared/image-file-extensions'

type ClipboardImageFileStat = {
  isFile: () => boolean
  size: number
}

type ReadWindowsClipboardImageFileDeps = {
  platform: NodeJS.Platform
  readClipboardFormatBuffer: (format: string) => Buffer
  statFile: (filePath: string) => Promise<ClipboardImageFileStat>
  createImageFromPath: (filePath: string) => NativeImage
}

const IMAGE_FILE_EXTENSION_SET = new Set(IMAGE_FILE_EXTENSIONS)

function decodeWindowsClipboardFileName(value: Buffer): string | null {
  if (value.byteLength % 2 !== 0) {
    return null
  }
  const decoded = value.toString('utf16le')
  let end = decoded.length
  while (end > 0 && decoded.charCodeAt(end - 1) === 0) {
    end -= 1
  }
  const filePath = decoded.slice(0, end)
  if (!filePath || filePath.includes('\0') || !win32.isAbsolute(filePath)) {
    return null
  }
  return IMAGE_FILE_EXTENSION_SET.has(extname(filePath).toLowerCase()) ? filePath : null
}

export async function readWindowsClipboardImageFileAsPng({
  platform,
  readClipboardFormatBuffer,
  statFile,
  createImageFromPath
}: ReadWindowsClipboardImageFileDeps): Promise<Buffer | null> {
  if (platform !== 'win32') {
    return null
  }

  // Why: Explorer copies files as CF_HDROP/FileNameW, not bitmap data, so
  // clipboard.readImage() cannot see a copied image file.
  const filePath = decodeWindowsClipboardFileName(readClipboardFormatBuffer('FileNameW'))
  if (!filePath) {
    return null
  }

  let file: ClipboardImageFileStat
  try {
    file = await statFile(filePath)
  } catch {
    return null
  }
  if (!file.isFile()) {
    return null
  }
  assertClipboardImageByteLengthWithinLimit(file.size)

  const image = createImageFromPath(filePath)
  if (image.isEmpty()) {
    return null
  }
  assertClipboardImageDimensionsWithinLimit(image.getSize())
  const png = image.toPNG()
  assertClipboardImageByteLengthWithinLimit(png.byteLength)
  return png
}
