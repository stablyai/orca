export const CODEX_MICRO_PROTOCOL_VERSION = 1
export const CODEX_MICRO_MAX_FRAME_BYTES = 64 * 1024
const FRAME_HEADER_BYTES = 4

export function encodeCodexMicroFrame(message: Record<string, unknown>): Buffer {
  const body = Buffer.from(
    JSON.stringify({ version: CODEX_MICRO_PROTOCOL_VERSION, ...message }),
    'utf8'
  )
  if (body.byteLength > CODEX_MICRO_MAX_FRAME_BYTES) {
    throw new Error('codex-micro: outgoing frame exceeds max frame size')
  }
  const header = Buffer.alloc(FRAME_HEADER_BYTES)
  header.writeUInt32BE(body.byteLength, 0)
  return Buffer.concat([header, body])
}

export type CodexMicroFrameDecodeResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'frame-too-large' | 'malformed' | 'unsupported-version' }

function decodeFrameBody(body: Buffer): CodexMicroFrameDecodeResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'malformed' }
  }
  const version = (parsed as Record<string, unknown>).version
  if (version !== CODEX_MICRO_PROTOCOL_VERSION) {
    return { ok: false, reason: 'unsupported-version' }
  }
  return { ok: true, value: parsed }
}

/** Stateful stdout decoder: buffers partial frames, never logs raw bytes. */
export class CodexMicroFrameDecoder {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  push(chunk: Buffer): CodexMicroFrameDecodeResult[] {
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const results: CodexMicroFrameDecodeResult[] = []

    for (;;) {
      if (this.buffer.byteLength < FRAME_HEADER_BYTES) {
        break
      }
      const len = this.buffer.readUInt32BE(0)
      if (len > CODEX_MICRO_MAX_FRAME_BYTES) {
        // Cannot trust a resync point past a bogus length; drop the buffer.
        this.buffer = Buffer.alloc(0)
        results.push({ ok: false, reason: 'frame-too-large' })
        break
      }
      if (this.buffer.byteLength < FRAME_HEADER_BYTES + len) {
        break
      }
      const body = this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + len)
      this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES + len)
      results.push(decodeFrameBody(body))
    }

    return results
  }
}
