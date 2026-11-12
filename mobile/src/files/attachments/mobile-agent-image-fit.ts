import {
  AGENT_IMAGE_MAX_BYTES,
  AGENT_IMAGE_MAX_LONG_EDGE,
  clipboardImageSizeWithinEdge,
  encodeClipboardImageWithinLimit,
  type ClipboardImageDimensions
} from '../../../../src/shared/clipboard-image'
import { base64DecodedByteLength } from '../../../../src/shared/agent-session/agent-session-attachments'
import { detectImageFileSignature } from '../../../../src/shared/image-file-signature'
import { decodeBase64Bytes } from '../../transport/encryption/base64-byte-codec'
import type { PickedMobileImage } from '../../platform/media-picker-contract'

// Page-only: decodes and re-encodes through the WebView's canvas.

const DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+;base64,/i
const SIGNATURE_BASE64_CHARS = 16
const JPEG_QUALITY = 0.85

function encodeJpegBase64(image: HTMLImageElement, size: ClipboardImageDimensions): string {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error('Failed to encode image')
  }
  // JPEG has no alpha, so transparent pixels would otherwise turn black.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size.width, size.height)
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, size.width, size.height)
  const encoded = canvas.toDataURL('image/jpeg', JPEG_QUALITY).replace(DATA_URL_PREFIX_RE, '')
  if (encoded.length === 0) {
    throw new Error('Failed to encode image')
  }
  return encoded
}

/** Shrink a photo to what agents accept; small images in formats they read pass through unchanged. */
export async function fitMobileAgentImageBase64(data: string, mimeHint?: string): Promise<string> {
  const base64 = data.replace(DATA_URL_PREFIX_RE, '')
  const signature = detectImageFileSignature(
    decodeBase64Bytes(base64.slice(0, SIGNATURE_BASE64_CHARS))
  )
  const image = new Image()
  image.src = `data:${signature?.mimeType ?? mimeHint ?? 'image/png'};base64,${base64}`
  try {
    await image.decode()
  } catch (error) {
    // A format agents read uploads as picked; anything else would reach them as an unreadable .png.
    if (signature !== null) {
      return base64
    }
    throw error
  }
  const source = { width: image.naturalWidth, height: image.naturalHeight }
  const size = clipboardImageSizeWithinEdge(source, AGENT_IMAGE_MAX_LONG_EDGE)
  if (
    signature !== null &&
    size.width === source.width &&
    size.height === source.height &&
    base64DecodedByteLength(base64) <= AGENT_IMAGE_MAX_BYTES
  ) {
    return base64
  }
  return encodeClipboardImageWithinLimit(
    size,
    (target) => encodeJpegBase64(image, target),
    base64DecodedByteLength,
    AGENT_IMAGE_MAX_BYTES
  )
}

/** Files-app picks that aren't images carry a fileName and upload as-is. */
export async function fitMobileAgentImage(image: PickedMobileImage): Promise<PickedMobileImage> {
  if (image.fileName !== undefined) {
    return image
  }
  return { ...image, base64: await fitMobileAgentImageBase64(image.base64, image.mime) }
}
