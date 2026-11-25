import { nativeImage, type NativeImage } from 'electron'
import { decodeIcoEntry } from './ico-bitmap-decode'

// macOS nativeImage can't read ICO, the most common favicon format, so take its best-sized image.
function decode(bytes: Uint8Array, maxEdge: number): NativeImage {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes))
  if (!image.isEmpty()) {
    return image
  }
  const ico = decodeIcoEntry(bytes, maxEdge)
  if (ico?.kind === 'png') {
    return nativeImage.createFromBuffer(Buffer.from(ico.bytes))
  }
  return ico
    ? nativeImage.createFromBitmap(ico.bgra, { width: ico.width, height: ico.height })
    : image
}

/** Re-encode as PNG within maxEdge without upscaling. */
export function encodeRepoIconPng(bytes: Uint8Array, maxEdge: number): Uint8Array | null {
  const image = decode(bytes, maxEdge)
  const { width, height } = image.getSize()
  if (image.isEmpty() || width <= 0 || height <= 0) {
    return null
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  const fitted =
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: 'best'
        })
      : image
  const png = fitted.toPNG()
  return png.byteLength > 0 ? png : null
}
