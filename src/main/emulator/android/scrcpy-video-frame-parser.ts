// scrcpy v2.4 with send_codec_meta and send_frame_meta enabled.

import type { RelayFrameBuffer } from '../../../shared/relay-frame-buffer'

const FRAME_HEADER_SIZE = 12
const CODEC_META_SIZE = 12
// Reject implausible frame sizes before buffering toward OOM.
const MAX_FRAME_BYTES = 16 * 1024 * 1024
// Caps per-object overhead when a socket delivers one frame as many tiny chunks.
export const MAX_PENDING_CHUNKS = 1024
// Top two bits of the 64-bit PTS field carry packet flags.
const CONFIG_FLAG = 1n << 63n
const KEY_FRAME_FLAG = 1n << 62n
const PTS_MASK = (1n << 62n) - 1n

export type ScrcpyVideoMeta = { codecId: string; width: number; height: number }

function parseCodecId(bytes: Buffer): string {
  let id = ''
  for (const byte of bytes) {
    if (byte !== 0) {
      id += String.fromCharCode(byte)
    }
  }
  return id
}

// Wire layout: 4-byte codec ID, 32-bit width, 32-bit height.
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
    if (pendingHead.buffer.byteLength > Math.max(Buffer.poolSize, pendingHead.length * 2)) {
      buffer.append(Buffer.from(buffer.drain()))
    }
  }
  if (buffer.chunkCount > MAX_PENDING_CHUNKS) {
    buffer.append(buffer.drain())
  }
  return frames
}
