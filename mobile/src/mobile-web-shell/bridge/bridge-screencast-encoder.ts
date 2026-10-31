import type { BrowserScreencastFrame } from '../../transport/browser-screencast-protocol'
import type { BridgeBinaryEvent } from './bridge-screencast-binary'

// Encode image bytes only; JSON already carries frame metadata, and the page reconstructs the native listener shape without a socket header.
export function encodeBridgeScreencastFrame(frame: BrowserScreencastFrame): BridgeBinaryEvent {
  return { ...bridgeScreencastFrameHeader(frame), b64: encodeBase64(frame.image) }
}

// Build encoding from this image-free envelope so measurement cannot drift. ASCII base64 adds exactly its known length, allowing cap checks before the full-image pass.
export function bridgeScreencastFrameHeader(frame: BrowserScreencastFrame): BridgeBinaryEvent {
  return {
    b64: '',
    format: frame.format,
    // Use screencast frameSeq; bridge seq belongs to acknowledgement/backpressure.
    frameSeq: frame.seq,
    metadata: frame.metadata
  }
}

export function bridgeScreencastBase64Length(imageByteLength: number): number {
  return Math.ceil(imageByteLength / 3) * 4
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Emit N/3 short strings and join once for engine-independent allocation cost; V8 benchmark wins for concatenation do not establish Hermes rope behavior.
export function encodeBase64(bytes: Uint8Array): string {
  const groups: string[] = []
  let offset = 0
  for (; offset + 2 < bytes.length; offset += 3) {
    const triple = (bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!
    groups.push(
      BASE64_ALPHABET[(triple >> 18) & 63]! +
        BASE64_ALPHABET[(triple >> 12) & 63]! +
        BASE64_ALPHABET[(triple >> 6) & 63]! +
        BASE64_ALPHABET[triple & 63]!
    )
  }
  const remaining = bytes.length - offset
  if (remaining === 1) {
    const triple = bytes[offset]! << 16
    groups.push(
      `${BASE64_ALPHABET[(triple >> 18) & 63]!}${BASE64_ALPHABET[(triple >> 12) & 63]!}==`
    )
  } else if (remaining === 2) {
    const triple = (bytes[offset]! << 16) | (bytes[offset + 1]! << 8)
    groups.push(
      `${BASE64_ALPHABET[(triple >> 18) & 63]!}${BASE64_ALPHABET[(triple >> 12) & 63]!}${BASE64_ALPHABET[(triple >> 6) & 63]!}=`
    )
  }
  return groups.join('')
}
