import type { NativeImage } from 'electron'

export const CLIPBOARD_IMAGE_MAX_UNCOMPRESSED_BYTES = 5 * 1024 * 1024

/**
 * When pasting clipboard screenshots, if the resulting image exceeds 5MB,
 * auto-compress by re-encoding to JPEG and/or downscaling dimensions to fit within 5MB.
 */
export function compressClipboardImageIfExceedsLimit(
  image: NativeImage,
  maxBytes = CLIPBOARD_IMAGE_MAX_UNCOMPRESSED_BYTES
): Buffer {
  const png = image.toPNG()
  if (png.byteLength <= maxBytes) {
    return png
  }

  if (typeof image.toJPEG === 'function') {
    const jpeg85 = image.toJPEG(85)
    if (jpeg85.byteLength <= maxBytes) {
      return jpeg85
    }
    const jpeg70 = image.toJPEG(70)
    if (jpeg70.byteLength <= maxBytes) {
      return jpeg70
    }
    if (typeof image.resize === 'function') {
      const size = image.getSize()
      let scale = Math.min(0.85, Math.sqrt(maxBytes / jpeg70.byteLength) * 0.95)
      while (scale >= 0.2) {
        const width = Math.max(1, Math.round(size.width * scale))
        const height = Math.max(1, Math.round(size.height * scale))
        const resized = image.resize({ width, height, quality: 'better' })
        const candidate =
          typeof resized.toJPEG === 'function' ? resized.toJPEG(75) : resized.toPNG()
        if (candidate.byteLength <= maxBytes) {
          return candidate
        }
        scale *= 0.75
      }
      const minWidth = Math.max(1, Math.round(size.width * 0.2))
      const minHeight = Math.max(1, Math.round(size.height * 0.2))
      const minResized = image.resize({ width: minWidth, height: minHeight, quality: 'good' })
      if (typeof minResized.toJPEG === 'function') {
        return minResized.toJPEG(60)
      }
    }
    return jpeg70
  }
  return png
}

export function compressCopiedFilePngIfExceedsLimit(
  buffer: Buffer,
  createImage: (buffer: Buffer) => NativeImage,
  maxBytes = CLIPBOARD_IMAGE_MAX_UNCOMPRESSED_BYTES
): Buffer {
  if (buffer.byteLength <= maxBytes) {
    return buffer
  }
  try {
    const image = createImage(buffer)
    if (!image.isEmpty()) {
      return compressClipboardImageIfExceedsLimit(image, maxBytes)
    }
  } catch {
    // Keep original
  }
  return buffer
}
