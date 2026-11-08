import type { TerminalOutputFrameChunk } from '../../terminal-output-frame-chunks'

const OSC_SIDE_EFFECTS = [']52;', ']9;', ']777;', ']99;']
// Alternate-screen enter/exit (?1049, ?1047, ?47 alone or in a list) and OSC clipboard/notification writes, raw or
// JSON-escaped in span frames, are what a screen-only snapshot cannot replay; a loose match only forgoes superseding.
const UNSUPERSEDABLE_MARKERS = [
  '1049',
  '1047',
  '?47',
  ';47',
  ...OSC_SIDE_EFFECTS.flatMap((osc) => [`\x1b${osc}`, `\\u001b${osc}`])
].map((marker) => Buffer.from(marker, 'latin1'))
// A marker split across frames leaves at most this many bytes in the earlier one.
export const SUPERSEDABLE_SCAN_TAIL_BYTES =
  Math.max(...UNSUPERSEDABLE_MARKERS.map((marker) => marker.byteLength)) - 1

// Queued frames are rechecked on every ACK, so scan each frame body once.
const frameHasMarker = new WeakMap<TerminalOutputFrameChunk, boolean>()

function containsMarker(bytes: Uint8Array<ArrayBufferLike>): boolean {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return UNSUPERSEDABLE_MARKERS.some((marker) => view.includes(marker))
}

function frameContainsMarker(chunk: TerminalOutputFrameChunk): boolean {
  let found = frameHasMarker.get(chunk)
  if (found === undefined) {
    found = containsMarker(chunk.bytes)
    frameHasMarker.set(chunk, found)
  }
  return found
}

export function supersedableScanTail(
  previousTail: Uint8Array<ArrayBufferLike>,
  bytes: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBufferLike> {
  if (bytes.byteLength >= SUPERSEDABLE_SCAN_TAIL_BYTES) {
    return bytes.slice(bytes.byteLength - SUPERSEDABLE_SCAN_TAIL_BYTES)
  }
  return Buffer.concat([previousTail, bytes]).subarray(-SUPERSEDABLE_SCAN_TAIL_BYTES)
}

/** True when a screen-only alt snapshot fully replaces these frames: none switches screen or carries a side effect.
 * `sentTail` is the end of the last frame already sent, so a marker split across that boundary still counts. */
export function framesAreSupersedable(
  sentTail: Uint8Array<ArrayBufferLike>,
  chunks: readonly TerminalOutputFrameChunk[]
): boolean {
  let tail = sentTail
  // Both sides are bounded by the tail length, so one fixed buffer holds every seam.
  const seam = Buffer.alloc(2 * SUPERSEDABLE_SCAN_TAIL_BYTES)
  for (const chunk of chunks) {
    if (frameContainsMarker(chunk)) {
      return false
    }
    seam.set(tail, 0)
    const head = chunk.bytes.subarray(0, SUPERSEDABLE_SCAN_TAIL_BYTES)
    seam.set(head, tail.byteLength)
    if (containsMarker(seam.subarray(0, tail.byteLength + head.byteLength))) {
      return false
    }
    tail = supersedableScanTail(tail, chunk.bytes)
  }
  return true
}
