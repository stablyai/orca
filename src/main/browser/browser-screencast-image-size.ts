import type { BrowserScreencastFormat } from '../../shared/browser-screencast-protocol'

type ImageSize = {
  width: number
  height: number
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  )
}

function readJpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null
  }
  let offset = 2
  while (offset + 3 < bytes.byteLength) {
    while (bytes[offset] === 0xff) {
      offset += 1
    }
    const marker = bytes[offset]
    offset += 1
    if (marker === 0xd9 || marker === 0xda) {
      return null
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      continue
    }
    if (offset + 2 > bytes.byteLength) {
      return null
    }
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1]
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      return null
    }
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) {
        return null
      }
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4]
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6]
      return width > 0 && height > 0 ? { width, height } : null
    }
    offset += segmentLength
  }
  return null
}

function readPngSize(bytes: Uint8Array): ImageSize | null {
  if (
    bytes.byteLength < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  return width > 0 && height > 0 ? { width, height } : null
}

export function readBrowserScreencastImageSize(
  bytes: Uint8Array,
  format: BrowserScreencastFormat
): ImageSize | null {
  return format === 'png' ? readPngSize(bytes) : readJpegSize(bytes)
}
