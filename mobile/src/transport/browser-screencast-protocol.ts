const BROWSER_SCREENCAST_KIND = 0x62
const BROWSER_SCREENCAST_VERSION = 1
const HEADER_BYTES = 16
/**
 * Every metadata field a frame carries, exported because the page's frame-area budget sizes the
 * envelope from this list rather than from a copy of it.
 */
export const METADATA_KEYS = [
  'offsetTop',
  'pageScaleFactor',
  'deviceWidth',
  'deviceHeight',
  'imageWidth',
  'imageHeight',
  'scrollOffsetX',
  'scrollOffsetY',
  'timestamp'
] as const

export enum BrowserScreencastOpcode {
  Frame = 1
}

export type BrowserScreencastFormat = 'jpeg' | 'png'

export type BrowserScreencastFrameMetadata = {
  offsetTop?: number
  pageScaleFactor?: number
  deviceWidth?: number
  deviceHeight?: number
  imageWidth?: number
  imageHeight?: number
  scrollOffsetX?: number
  scrollOffsetY?: number
  timestamp?: number
}

export type BrowserScreencastFrame = {
  opcode: BrowserScreencastOpcode.Frame
  seq: number
  format: BrowserScreencastFormat
  metadata: BrowserScreencastFrameMetadata
  image: Uint8Array
  /**
   * The image as the sender already had it, when the sender had it as base64.
   *
   * Optional because only the bridge carries one: this module decodes a socket frame, where the
   * image is bytes and there is no base64 to keep. It exists so the page's data URI can reuse the
   * encoding the bridge was given instead of producing it a second time; nothing reads it as the
   * image, and `image` is the field every consumer is still written against.
   */
  b64?: string
}

function byteToFormat(value: number): BrowserScreencastFormat | null {
  if (value === 1) {
    return 'jpeg'
  }
  if (value === 2) {
    return 'png'
  }
  return null
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function decodeFrameMetadata(bytes: Uint8Array): BrowserScreencastFrameMetadata | null {
  const raw = decodeJson(bytes)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const input = raw as Record<string, unknown>
  const metadata: BrowserScreencastFrameMetadata = {}
  for (const key of METADATA_KEYS) {
    const value = input[key]
    if (isFiniteNumber(value)) {
      metadata[key] = value
    }
  }
  return metadata
}

export function decodeBrowserScreencastFrame(bytes: Uint8Array): BrowserScreencastFrame | null {
  if (bytes.byteLength < HEADER_BYTES) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    view.getUint8(0) !== BROWSER_SCREENCAST_KIND ||
    view.getUint8(1) !== BROWSER_SCREENCAST_VERSION
  ) {
    return null
  }
  if (view.getUint8(2) !== BrowserScreencastOpcode.Frame) {
    return null
  }
  const format = byteToFormat(view.getUint8(3))
  if (!format) {
    return null
  }
  const seq = view.getUint32(4, true)
  const metadataLength = view.getUint32(8, true)
  if (view.getUint32(12, true) !== 0) {
    return null
  }
  const imageStart = HEADER_BYTES + metadataLength
  if (imageStart > bytes.byteLength) {
    return null
  }
  const metadata = decodeFrameMetadata(bytes.subarray(HEADER_BYTES, imageStart))
  if (!metadata) {
    return null
  }
  return {
    opcode: BrowserScreencastOpcode.Frame,
    seq,
    format,
    metadata,
    image: bytes.subarray(imageStart)
  }
}
