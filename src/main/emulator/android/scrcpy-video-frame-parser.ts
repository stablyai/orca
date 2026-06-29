// scrcpy server video protocol v2.4 (send_codec_meta + send_frame_meta enabled).
// Pure parsing of the H.264 byte stream the scrcpy server writes to the video
// socket. The socket reader (scrcpy-stream-session) feeds chunks here; this file
// has no I/O so the framing is unit-testable.

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

export type ScrcpyFrameParseResult = { frames: ScrcpyVideoFrame[]; pending: Buffer }

// Extracts complete frames from `pending + chunk`, returning the leftover bytes
// of any partially-received frame so the caller can prepend them to the next chunk.
export function parseScrcpyVideoFrames(pending: Buffer, chunk: Buffer): ScrcpyFrameParseResult {
  const buffer = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
  const frames: ScrcpyVideoFrame[] = []
  let offset = 0

  while (buffer.length - offset >= FRAME_HEADER_SIZE) {
    const meta = buffer.readBigUInt64BE(offset)
    const size = buffer.readUInt32BE(offset + 8)
    if (size > MAX_FRAME_BYTES) {
      throw new Error(`scrcpy frame size ${size} exceeds ${MAX_FRAME_BYTES}; stream desynced`)
    }
    const dataStart = offset + FRAME_HEADER_SIZE
    if (buffer.length - dataStart < size) {
      break
    }
    frames.push({
      config: (meta & CONFIG_FLAG) !== 0n,
      keyFrame: (meta & KEY_FRAME_FLAG) !== 0n,
      pts: meta & PTS_MASK,
      data: Buffer.from(buffer.subarray(dataStart, dataStart + size))
    })
    offset = dataStart + size
  }

  return { frames, pending: offset > 0 ? Buffer.from(buffer.subarray(offset)) : buffer }
}
