// Chrome native messaging framing: a 4-byte little-endian length prefix
// followed by that many bytes of UTF-8 JSON. Args cannot be passed to a
// native host, so this framing is the only channel.
const LENGTH_PREFIX_BYTES = 4

// Chrome caps one message at ~1 MB; this ceiling only guards against a
// corrupt prefix demanding a huge allocation.
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

// Chrome rejects a host->browser message over 1 MB and drops the connection,
// so refuse to emit one rather than lose the pipe mid-response.
export const MAX_OUTBOUND_FRAME_BYTES = 1024 * 1024

export class NativeMessageFrameError extends Error {
  // Why: frames decoded before the bad one in the same chunk are still valid;
  // carry them so the caller can act on them before ending the connection.
  constructor(
    message: string,
    readonly decodedFrames: string[] = []
  ) {
    super(message)
  }
}

export function encodeNativeMessage(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  if (payload.length > MAX_OUTBOUND_FRAME_BYTES) {
    throw new NativeMessageFrameError(
      `outbound frame ${payload.length} exceeds ${MAX_OUTBOUND_FRAME_BYTES}`
    )
  }
  const header = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES)
  header.writeUInt32LE(payload.length, 0)
  return Buffer.concat([header, payload])
}

// Streaming decoder: framing lives here, JSON validity is the caller's job
// (returns raw UTF-8 strings so a malformed body becomes an error response,
// not a decoder crash).
export class NativeMessageDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  feed(chunk: Buffer): string[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages: string[] = []
    while (this.buffer.length >= LENGTH_PREFIX_BYTES) {
      const length = this.buffer.readUInt32LE(0)
      if (length > MAX_FRAME_BYTES) {
        throw new NativeMessageFrameError(
          `frame length ${length} exceeds ${MAX_FRAME_BYTES}`,
          messages
        )
      }
      if (this.buffer.length < LENGTH_PREFIX_BYTES + length) {
        break
      }
      const payload = this.buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length)
      this.buffer = this.buffer.subarray(LENGTH_PREFIX_BYTES + length)
      messages.push(payload.toString('utf8'))
    }
    return messages
  }
}
