import { nativeImage, type NativeImage } from 'electron'
import { clipboardFormatReader, readClipboardBuffer } from './clipboard-formats'
import {
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
} from '../../shared/clipboard-image'
import { readRasterImageDimensions } from '../../shared/raster-image-dimensions'

export async function readClipboardNativeImage(): Promise<NativeImage> {
  const imageTypes = (await clipboardFormatReader.availableFormats()).filter((type) =>
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
    const buffer = await readClipboardBuffer(format, assertClipboardImageByteLengthWithinLimit)
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
