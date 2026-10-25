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

/** Why: on macOS, availableFormats reports MIME names but readBuffer only finds bytes under
 *  the pasteboard UTI (real-clipboard probe on Electron 43.8.1: readBuffer('image/png') is
 *  empty while 'public.png' holds the bytes — exactly the CleanShot X shape of #26739).
 *  The UTI retry is gated on the reader's own has() primitive (see
 *  MAC_PASTEBOARD_IMAGE_TYPES in clipboard-image-source) so Windows/Linux, where the MIME
 *  name already carries the bytes, never issue a speculative read. */
const PASTEBOARD_UTI_BY_MIME: Record<string, string> = {
  'image/png': 'public.png',
  'image/jpeg': 'public.jpeg',
  'image/tiff': 'public.tiff'
}

function readFlavorBuffer(clipboard: ClipboardImageReader, format: string): Buffer {
  const buffer = clipboard.readBuffer(format)
  if (buffer.byteLength > 0) {
    return buffer
  }
  const uti = PASTEBOARD_UTI_BY_MIME[format]
  return uti && clipboard.has(uti) ? clipboard.readBuffer(uti) : buffer
}

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
    const buffer = readFlavorBuffer(clipboard, format)
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
