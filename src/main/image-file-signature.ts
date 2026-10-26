export type ImageFileSignature = {
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  extension: 'png' | 'jpg' | 'gif' | 'webp'
}

export const IMAGE_SIGNATURE_BYTES = 12

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]

function startsWith(buffer: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  return (
    buffer.length >= offset + bytes.length &&
    bytes.every((byte, index) => buffer[offset + index] === byte)
  )
}

function startsWithAscii(buffer: Uint8Array, text: string, offset = 0): boolean {
  return startsWith(
    buffer,
    Array.from(text, (char) => char.charCodeAt(0)),
    offset
  )
}

// Signature checks identify file types without proving the image decodes.
export function detectImageFileSignature(buffer: Uint8Array): ImageFileSignature | null {
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return { mimeType: 'image/png', extension: 'png' }
  }
  if (startsWith(buffer, JPEG_SIGNATURE)) {
    return { mimeType: 'image/jpeg', extension: 'jpg' }
  }
  if (startsWithAscii(buffer, 'GIF87a') || startsWithAscii(buffer, 'GIF89a')) {
    return { mimeType: 'image/gif', extension: 'gif' }
  }
  if (startsWithAscii(buffer, 'RIFF') && startsWithAscii(buffer, 'WEBP', 8)) {
    return { mimeType: 'image/webp', extension: 'webp' }
  }
  return null
}
