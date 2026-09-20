import type { BrowserScreencastFrame } from '../../transport/browser-screencast-protocol'
import type { BridgeBinaryEvent } from './bridge-screencast-binary'

/**
 * The binary lane's shell-side half: a frame the native stream handed a listener, as the envelope's
 * `event.binary`.
 *
 * `decodeBridgeScreencastFrame` is the inverse and this exists to satisfy it. No wire header is
 * written, because the envelope already carries `format`, `frameSeq` and the metadata as JSON
 * beside the image: only the image is base64, and the page reconstructs the frame without parsing
 * anything.
 */
export function encodeBridgeScreencastFrame(frame: BrowserScreencastFrame): BridgeBinaryEvent {
  return { ...bridgeScreencastFrameHeader(frame), b64: encodeBase64(frame.image) }
}

/**
 * The same event with no image, which is what the frame costs before the image is added to it.
 *
 * Base64 is ASCII, so JSON escapes none of it: the encoded frame is this serialized plus exactly
 * `bridgeScreencastBase64Length(image)` more bytes. That is what lets the shell price a frame
 * before paying a base64 pass over one it may not be able to send.
 *
 * `encodeBridgeScreencastFrame` is built from this rather than beside it, so the shape measured and
 * the shape sent cannot drift.
 */
export function bridgeScreencastFrameHeader(frame: BrowserScreencastFrame): BridgeBinaryEvent {
  return {
    b64: '',
    format: frame.format,
    // The screencast's own counter. The event frame's `seq` is the bridge's backpressure ordinal,
    // and sending that one would renumber every frame the page reports.
    frameSeq: frame.seq,
    metadata: frame.metadata
  }
}

/** What `encodeBase64` will return for an image this long, without encoding it. */
export function bridgeScreencastBase64Length(imageByteLength: number): number {
  return Math.ceil(imageByteLength / 3) * 4
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * `Uint8Array` to base64, three bytes at a time.
 *
 * Its own rather than `e2ee.ts`'s, which is not exported and belongs to a subsystem this one has
 * nothing to do with. Measured on Node against that module's shape and two chunked `fromCharCode`
 * variants, all four agreeing with `Buffer.from(image).toString('base64')` byte for byte: at the
 * measured 77 KB phone frame 0.52 ms here against 0.27 ms per-byte and 0.87 ms chunked, and at the
 * largest frame the envelope admits 3.43 / 3.15 / 5.18 ms. So the per-byte form is not the
 * quadratic one on V8 — its ropes absorb it — and the chunked one it was meant to beat is the
 * slowest of the three.
 *
 * This is here for the reason that survives not knowing Hermes, which is the engine the shell
 * actually runs: its cost is N/3 short strings and one join, which no engine's string-concatenation
 * strategy changes, where both other forms are fast or slow exactly as the engine ropes `+=`.
 */
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
