import { clipboard, nativeImage, type NativeImage } from 'electron'
import {
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
} from '../../shared/clipboard-image'
import { readRasterImageDimensions } from '../../shared/raster-image-dimensions'

export function readClipboardNativeImage(): NativeImage {
  const image = clipboard.readImage()
  if (!image.isEmpty() || process.platform !== 'darwin') {
    return image
  }
  // CleanShot can store JPEG bytes as public.png, which readImage decodes as PNG only.
  const buffer = clipboard.readBuffer('public.png')
  if (buffer.length === 0) {
    return image
  }
  assertClipboardImageByteLengthWithinLimit(buffer.length)
  const dimensions = readRasterImageDimensions(buffer)
  if (dimensions) {
    assertClipboardImageDimensionsWithinLimit(dimensions)
  }
  return nativeImage.createFromBuffer(buffer)
}
