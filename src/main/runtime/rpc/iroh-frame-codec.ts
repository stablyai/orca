// Length-prefixed framing for the iroh mobile transport.
// Wire: 4-byte big-endian u32 length + opaque E2EE payload.
import {
  REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES,
  REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES,
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
} from '../../../shared/remote-runtime/remote-runtime-memory-limits'

export const IROH_MOBILE_RPC_ALPN = 'orca-mobile-rpc/1'
export const IROH_PRE_AUTH_MAX_FRAME_BYTES = REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES
// V2 adds a 42-byte header to v1's 24-byte nonce + 16-byte MAC; only text is base64 on wire.
const E2EE_MAX_OVERHEAD_BYTES = 24 + 16 + 42
export const IROH_MAX_FRAME_BYTES = Math.max(
  Math.ceil((REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES + E2EE_MAX_OVERHEAD_BYTES) / 3) * 4,
  REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES + E2EE_MAX_OVERHEAD_BYTES
)
export const IROH_LENGTH_PREFIX_BYTES = 4

/** Prefix a payload with its big-endian length, rejecting frames above the wire cap. */
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
  maxFrameBytes?: () => number
}

/** Decode fragments linearly, checking the current admission cap before allocating each payload. */
export function createFrameDecoder(callbacks: FrameDecoderCallbacks): {
  feed: (chunk: Uint8Array) => void
  reset: () => void
} {
  const header = Buffer.allocUnsafe(IROH_LENGTH_PREFIX_BYTES)
  let headerBytes = 0
  let payload: Uint8Array | null = null
  let payloadBytes = 0

  return {
    feed(chunk: Uint8Array): void {
      let offset = 0
      while (offset < chunk.byteLength) {
        if (payload === null) {
          const count = Math.min(IROH_LENGTH_PREFIX_BYTES - headerBytes, chunk.byteLength - offset)
          header.set(chunk.subarray(offset, offset + count), headerBytes)
          headerBytes += count
          offset += count
          if (headerBytes < IROH_LENGTH_PREFIX_BYTES) {
            return
          }
          const length = header.readUInt32BE(0)
          headerBytes = 0
          if (length > (callbacks.maxFrameBytes?.() ?? IROH_MAX_FRAME_BYTES)) {
            callbacks.onOversize(length)
            return
          }
          // Allocate once per bounded frame, not once per network fragment.
          payload = new Uint8Array(length)
        }
        const count = Math.min(payload.byteLength - payloadBytes, chunk.byteLength - offset)
        payload.set(chunk.subarray(offset, offset + count), payloadBytes)
        payloadBytes += count
        offset += count
        if (payloadBytes === payload.byteLength) {
          const complete = payload
          payload = null
          payloadBytes = 0
          callbacks.onFrame(complete)
        }
      }
    },
    reset(): void {
      headerBytes = 0
      payload = null
      payloadBytes = 0
    }
  }
}

/** Recover WS text/binary semantics: ASCII text stays text, other payloads stay binary. */
export function decodeIrohFramePayload(payload: Uint8Array): string | Uint8Array {
  for (let i = 0; i < payload.byteLength; i++) {
    const byte = payload[i]!
    if (byte > 0x7e || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      return payload
    }
  }
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8')
}

/** Encode text as UTF-8 and retain binary payload views without copying their bytes. */
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
