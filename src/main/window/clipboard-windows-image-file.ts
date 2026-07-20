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
  readClipboardFormat: (format: string) => string
  statFile: (filePath: string) => Promise<ClipboardImageFileStat>
  createImageFromPath: (filePath: string) => NativeImage
}

const IMAGE_FILE_EXTENSION_SET = new Set(IMAGE_FILE_EXTENSIONS)

function decodeWindowsClipboardFileName(value: string): string | null {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 0) {
    end -= 1
  }
  const filePath = value.slice(0, end)
  if (!filePath || filePath.includes('\0') || !win32.isAbsolute(filePath)) {
    return null
  }
  return IMAGE_FILE_EXTENSION_SET.has(extname(filePath).toLowerCase()) ? filePath : null
}

export async function readWindowsClipboardImageFileAsPng({
  platform,
  readClipboardFormat,
  statFile,
  createImageFromPath
}: ReadWindowsClipboardImageFileDeps): Promise<Buffer | null> {
  if (platform !== 'win32') {
    return null
  }

  // Why: Explorer copies files as CF_HDROP/FileNameW, not bitmap data, so
  // clipboard.readImage() cannot see a copied image file.
  const filePath = decodeWindowsClipboardFileName(readClipboardFormat('FileNameW'))
  if (!filePath) {
    return null
  }

  const file = await statFile(filePath)
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
