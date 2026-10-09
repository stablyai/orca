import { nativeImage, type NativeImage } from 'electron'
import { assertClipboardImageDimensionsWithinLimit } from '../../shared/clipboard-image'
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
