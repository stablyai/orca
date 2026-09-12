// scrcpy server video protocol v2.4 (send_codec_meta + send_frame_meta enabled).
// Pure parsing of the H.264 byte stream the scrcpy server writes to the video
// socket. The socket reader (scrcpy-stream-session) feeds chunks here; this file
// has no I/O so the framing is unit-testable.

import type { RelayFrameBuffer } from '../../../shared/relay-frame-buffer'

const FRAME_HEADER_SIZE = 12
const CODEC_META_SIZE = 12
// scrcpy frames are well under this at the configured max_size; a larger
// size means a desynced stream — fail fast instead of buffering toward OOM.
const MAX_FRAME_BYTES = 16 * 1024 * 1024
// Top two bits of the 64-bit PTS field carry packet flags.
const CONFIG_FLAG = 1n << 63n
const KEY_FRAME_FLAG = 1n << 62n
const PTS_MASK = (1n << 62n) - 1n

export type ScrcpyVideoMeta = { codecId: string; width: number; height: number }

// The codec id is a 4-byte ascii tag, null-padded when shorter than 4 chars.
function parseCodecId(bytes: Buffer): string {
  let id = ''
  for (const byte of bytes) {
    if (byte !== 0) {
      id += String.fromCharCode(byte)
    }
  }
  return id
}

// Leading 12-byte codec metadata sent once before the frame stream: a 4-char
// codec id (e.g. "h264") followed by the initial width and height.
export function parseScrcpyVideoMeta(buffer: Buffer): ScrcpyVideoMeta | null {
  if (buffer.length < CODEC_META_SIZE) {
    return null
  }
  return {
    codecId: parseCodecId(buffer.subarray(0, 4)),
    width: buffer.readUInt32BE(4),
    height: buffer.readUInt32BE(8)
  }
}

export type ScrcpyVideoFrame = {
  // Config packets carry the SPS/PPS the decoder needs before any picture.
  config: boolean
  keyFrame: boolean
  pts: bigint
  data: Buffer
}

// Leave partial frames queued so fragmented payloads are not recopied on every chunk.
export function parseScrcpyVideoFrames(buffer: RelayFrameBuffer): ScrcpyVideoFrame[] {
  const frames: ScrcpyVideoFrame[] = []

  while (buffer.length >= FRAME_HEADER_SIZE) {
    const header = buffer.peek(FRAME_HEADER_SIZE)
    const meta = header.readBigUInt64BE(0)
    const size = header.readUInt32BE(8)
    if (size > MAX_FRAME_BYTES) {
      throw new Error(`scrcpy frame size ${size} exceeds ${MAX_FRAME_BYTES}; stream desynced`)
    }
    if (buffer.length < FRAME_HEADER_SIZE + size) {
      break
    }
    const packet = buffer.take(FRAME_HEADER_SIZE + size)
    frames.push({
      config: (meta & CONFIG_FLAG) !== 0n,
      keyFrame: (meta & KEY_FRAME_FLAG) !== 0n,
      pts: meta & PTS_MASK,
      data: Buffer.from(packet.subarray(FRAME_HEADER_SIZE))
    })
  }

  if (frames.length > 0 && buffer.length > 0) {
    const pendingHead = buffer.peek(1)
    // Compact only mostly consumed allocations larger than the reusable Buffer slab.
    if (pendingHead.buffer.byteLength > Math.max(Buffer.poolSize, pendingHead.length * 2)) {
      buffer.append(Buffer.from(buffer.drain()))
    }
  }
  return frames
}
