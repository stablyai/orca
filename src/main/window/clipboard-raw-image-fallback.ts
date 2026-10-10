import { nativeImage, type NativeImage } from 'electron'
import {
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
} from '../../shared/clipboard-image'
import { readRasterImageDimensions } from '../../shared/raster-image-dimensions'
import type { ClipboardImageReader } from './clipboard-image-source'

type ClipboardRawImageDeps = {
  createImageFromBuffer: (buffer: Buffer) => NativeImage
}

const RAW_IMAGE_FORMATS = ['image/png', 'image/jpeg', 'image/tiff']

/** Decode the first raw image flavor when Electron's readImage came back empty:
 *  tools like CleanShot X put JPEG bytes under the public.png flavor (#26739),
 *  which readImage reports as an empty image. Converts the surviving decode to
 *  PNG, or returns null when no flavor holds decodable bytes. */
export function readClipboardRawImageAsPng(
  clipboard: ClipboardImageReader,
  deps?: ClipboardRawImageDeps
): Buffer | null {
  // Why the electron default: the IPC handler passes nothing, so tests inject a fake.
  const createImageFromBuffer =
    deps?.createImageFromBuffer ?? ((buffer: Buffer) => nativeImage.createFromBuffer(buffer))
  const formats = clipboard.availableFormats()
  for (const format of RAW_IMAGE_FORMATS) {
    if (!formats.includes(format)) {
      continue
    }
    const buffer = clipboard.readBuffer(format)
    if (buffer.byteLength === 0) {
      continue
    }
    assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
    // Why: reject pixel bombs from encoded metadata before NativeImage allocates
    // the decoded pixels, mirroring the Windows file fallback. Flavors whose
    // bytes carry no parsable header (TIFF) skip this and stay covered by the
    // byte-length cap and the decoded-dimensions check below.
    const encodedDimensions = readRasterImageDimensions(buffer)
    if (encodedDimensions) {
      assertClipboardImageDimensionsWithinLimit(encodedDimensions)
    }
    let image: NativeImage
    try {
      image = createImageFromBuffer(buffer)
    } catch {
      continue
    }
    if (image.isEmpty()) {
      continue
    }
    assertClipboardImageDimensionsWithinLimit(image.getSize())
    return image.toPNG()
  }
  return null
}
