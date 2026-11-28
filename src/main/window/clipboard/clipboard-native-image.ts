import { nativeImage, type NativeImage } from 'electron'
import type { ClipboardFormatReader } from './clipboard-formats'
import {
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
} from '../../../shared/clipboard/clipboard-image'
import { readRasterImageDimensions } from '../../../shared/file-preview/raster-image-dimensions'

export async function readClipboardNativeImage(
  clipboard: ClipboardFormatReader
): Promise<NativeImage> {
  const imageTypes = (await clipboard.availableFormats()).filter((type) =>
    type.startsWith('image/')
  )
  const formats = [
    ...new Set([
      'image/png',
      ...imageTypes,
      ...(process.platform === 'darwin' ? ['public.png', 'public.tiff'] : [])
    ])
  ]
  for (const format of formats) {
    const buffer = await clipboard.readBuffer(format, assertClipboardImageByteLengthWithinLimit)
    if (buffer.length === 0) {
      continue
    }
    assertClipboardImageByteLengthWithinLimit(buffer.length)
    const dimensions = readRasterImageDimensions(buffer)
    if (dimensions) {
      assertClipboardImageDimensionsWithinLimit(dimensions)
    }
    const image = nativeImage.createFromBuffer(buffer)
    if (!image.isEmpty()) {
      assertClipboardImageDimensionsWithinLimit(image.getSize())
      return image
    }
  }
  return nativeImage.createEmpty()
}
