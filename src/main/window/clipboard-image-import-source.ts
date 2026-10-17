import type { Clipboard, NativeImage } from 'electron'
import {
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
} from '../../shared/clipboard-image'
import { readClipboardCopiedFilePaths } from './clipboard-copied-file-paths'
import { readClipboardImageSource } from './clipboard-image-source'

type ImportImage = Pick<NativeImage, 'isEmpty' | 'getSize' | 'toPNG'>
type ImageImportClipboard = Pick<Clipboard, 'availableFormats' | 'readBuffer' | 'has'> & {
  readImage: () => ImportImage
}

/** Capture pixels synchronously, before staging or destination lookup can yield. */
export function readClipboardImageForImport(
  clipboard: ImageImportClipboard,
  platform: NodeJS.Platform = process.platform,
  readImage: () => ImportImage = () => clipboard.readImage()
): Buffer | null {
  // FileNameW cannot enumerate a multi-file copy; never convert its preview into a PNG.
  if (platform === 'win32' && clipboard.readBuffer('Shell IDList Array').byteLength > 0) {
    return null
  }
  if (readClipboardCopiedFilePaths(clipboard, platform).length > 0) {
    return null
  }
  if (readClipboardImageSource(clipboard, platform)?.kind !== 'native') {
    return null
  }
  const image = readImage()
  if (image.isEmpty()) {
    return null
  }
  assertClipboardImageDimensionsWithinLimit(image.getSize())
  const png = image.toPNG()
  assertClipboardImageByteLengthWithinLimit(png.byteLength)
  if (png.byteLength === 0) {
    throw new Error('Clipboard image could not be encoded as PNG')
  }
  return png
}
