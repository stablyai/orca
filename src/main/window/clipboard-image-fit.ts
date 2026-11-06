import type { NativeImage } from 'electron'
import {
  CLIPBOARD_IMAGE_MAX_DOWNSCALE_ATTEMPTS,
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR,
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit,
  computeClipboardImageEncodedSizeDownscale,
  computeClipboardImagePixelDownscale
} from '../../shared/clipboard-image'

/** Minimal NativeImage surface so tests can inject fakes without Electron. */
export type FitClipboardImageSource = Pick<NativeImage, 'getSize' | 'isEmpty' | 'resize' | 'toPNG'>

/**
 * Encode a clipboard NativeImage as PNG under hard size caps.
 * Downscales when pixel count or PNG bytes would otherwise reject the paste.
 */
export function encodeClipboardImageWithinLimits(image: FitClipboardImageSource): Buffer {
  if (image.isEmpty()) {
    throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  }

  let current = image
  let { width, height } = current.getSize()
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  }

  const pixelTarget = computeClipboardImagePixelDownscale(width, height, CLIPBOARD_IMAGE_MAX_PIXELS)
  if (pixelTarget) {
    current = current.resize(pixelTarget)
    ;({ width, height } = current.getSize())
  }

  let png = current.toPNG()
  for (
    let attempt = 0;
    attempt < CLIPBOARD_IMAGE_MAX_DOWNSCALE_ATTEMPTS &&
    png.byteLength > CLIPBOARD_IMAGE_MAX_SOURCE_BYTES;
    attempt += 1
  ) {
    const target = computeClipboardImageEncodedSizeDownscale(
      png.byteLength,
      width,
      height,
      CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
    )
    if (!target) {
      break
    }
    current = current.resize(target)
    ;({ width, height } = current.getSize())
    png = current.toPNG()
  }

  assertClipboardImageDimensionsWithinLimit({ width, height })
  assertClipboardImageByteLengthWithinLimit(png.byteLength)
  return png
}
