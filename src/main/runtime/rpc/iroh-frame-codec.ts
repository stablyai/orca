// Length-prefixed framing for the iroh mobile transport.
// Wire: 4-byte big-endian u32 length + payload. Max frame 1 MiB.

export const IROH_MOBILE_RPC_ALPN = 'orca-mobile-rpc/1'
export const IROH_MAX_FRAME_BYTES = 1024 * 1024
export const IROH_LENGTH_PREFIX_BYTES = 4

export function encodeLengthPrefixedFrame(payload: Uint8Array): Buffer {
  if (payload.byteLength > IROH_MAX_FRAME_BYTES) {
    throw new Error(`iroh frame exceeds ${IROH_MAX_FRAME_BYTES} bytes`)
  }
  const out = Buffer.allocUnsafe(IROH_LENGTH_PREFIX_BYTES + payload.byteLength)
  out.writeUInt32BE(payload.byteLength, 0)
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(
    out,
    IROH_LENGTH_PREFIX_BYTES
  )
  return out
}

export type FrameDecoderCallbacks = {
  onFrame: (payload: Uint8Array) => void
  onOversize: (declaredLength: number) => void
}

// Incremental decoder for a single bi-stream. Rejects declared lengths above the cap.
export function createFrameDecoder(callbacks: FrameDecoderCallbacks): {
  feed: (chunk: Uint8Array) => void
  reset: () => void
} {
  let buffer = Buffer.alloc(0)
  let expectedLength: number | null = null

  return {
    feed(chunk: Uint8Array): void {
      if (chunk.byteLength === 0) {
        return
      }
      buffer = Buffer.concat([
        buffer,
        Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      ])
      while (true) {
        if (expectedLength === null) {
          if (buffer.byteLength < IROH_LENGTH_PREFIX_BYTES) {
            return
          }
          expectedLength = buffer.readUInt32BE(0)
          buffer = buffer.subarray(IROH_LENGTH_PREFIX_BYTES)
          if (expectedLength > IROH_MAX_FRAME_BYTES) {
            const oversize = expectedLength
            expectedLength = null
            buffer = Buffer.alloc(0)
            callbacks.onOversize(oversize)
            return
          }
        }
        if (buffer.byteLength < expectedLength) {
          return
        }
        const payload = buffer.subarray(0, expectedLength)
        buffer = buffer.subarray(expectedLength)
        expectedLength = null
        callbacks.onFrame(new Uint8Array(payload))
      }
    },
    reset(): void {
      buffer = Buffer.alloc(0)
      expectedLength = null
    }
  }
}

// Why: WS text frames (JSON/base64) are ASCII; sealed binary frames are
// high-entropy, so sniffing recovers the WS text/binary flag without spending
// a wire tag — the orca-mobile-rpc/1 frame is length + payload on purpose.
export function decodeIrohFramePayload(payload: Uint8Array): string | Uint8Array {
  for (let i = 0; i < payload.byteLength; i++) {
    const byte = payload[i]!
    if (byte > 0x7e || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      return payload
    }
  }
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8')
}

export function encodeIrohFramePayload(
  data: string | Uint8Array | Buffer,
  _binary?: boolean
): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return data
}
