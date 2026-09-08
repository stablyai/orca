export const MOBILE_WEB_RASTER_IMAGE_MAX_BYTES = 2 * 1024 * 1024

export type MobileWebRasterImageType = {
  mimeType: string
  label: string
}

export type MobileWebRasterImageValidation =
  | { valid: true; imageType: MobileWebRasterImageType }
  | { valid: false; reason: 'unsupported' | 'incomplete' | 'too_large' | 'signature_mismatch' }

const IMAGE_TYPE_BY_EXTENSION: Record<string, MobileWebRasterImageType> = {
  bmp: { mimeType: 'image/bmp', label: 'BMP' },
  gif: { mimeType: 'image/gif', label: 'GIF' },
  ico: { mimeType: 'image/x-icon', label: 'ICO' },
  jpeg: { mimeType: 'image/jpeg', label: 'JPEG' },
  jpg: { mimeType: 'image/jpeg', label: 'JPEG' },
  png: { mimeType: 'image/png', label: 'PNG' },
  webp: { mimeType: 'image/webp', label: 'WebP' }
}

export function isMobileWebRasterImagePath(relativePath: string): boolean {
  return mobileWebRasterImageTypeForPath(relativePath) !== null
}

export function validateMobileWebRasterImage(args: {
  relativePath: string
  bytes: Uint8Array
  eof: boolean
  limitReached: boolean
}): MobileWebRasterImageValidation {
  const imageType = mobileWebRasterImageTypeForPath(args.relativePath)
  if (!imageType) {
    return { valid: false, reason: 'unsupported' }
  }
  if (args.limitReached || args.bytes.byteLength > MOBILE_WEB_RASTER_IMAGE_MAX_BYTES) {
    return { valid: false, reason: 'too_large' }
  }
  if (!args.eof) {
    return { valid: false, reason: 'incomplete' }
  }
  if (!matchesImageSignature(imageType.mimeType, args.bytes)) {
    return { valid: false, reason: 'signature_mismatch' }
  }
  return { valid: true, imageType }
}

function mobileWebRasterImageTypeForPath(relativePath: string): MobileWebRasterImageType | null {
  const basename = relativePath.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  const extension = basename.includes('.') ? basename.split('.').at(-1) : undefined
  return extension ? (IMAGE_TYPE_BY_EXTENSION[extension] ?? null) : null
}

function matchesImageSignature(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === 'image/png') {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  }
  if (mimeType === 'image/jpeg') {
    return startsWith(bytes, [0xff, 0xd8, 0xff])
  }
  if (mimeType === 'image/gif') {
    return startsWithAscii(bytes, 'GIF87a') || startsWithAscii(bytes, 'GIF89a')
  }
  if (mimeType === 'image/webp') {
    return startsWithAscii(bytes, 'RIFF') && asciiAt(bytes, 8, 'WEBP')
  }
  if (mimeType === 'image/bmp') {
    return startsWithAscii(bytes, 'BM')
  }
  if (mimeType === 'image/x-icon') {
    return startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && readUint16Le(bytes, 4) > 0
  }
  return false
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  return asciiAt(bytes, 0, value)
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.byteLength) {
    return false
  }
  return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0))
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.byteLength) {
    return 0
  }
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}
