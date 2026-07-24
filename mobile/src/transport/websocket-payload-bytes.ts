import {
  assertMobileInboundFrameSize,
  MOBILE_INBOUND_MAX_FRAME_BYTES
} from './mobile-inbound-frame-queue'

const OVERSIZED_BINARY_MESSAGE = 'WebSocket binary payload exceeds inbound frame limit'

export async function websocketPayloadToUint8(
  value: unknown,
  maxBytes = MOBILE_INBOUND_MAX_FRAME_BYTES
): Promise<Uint8Array | null> {
  assertMobileInboundFrameSize(value, OVERSIZED_BINARY_MESSAGE, maxBytes)
  if (value instanceof Uint8Array) {
    return enforceConvertedLimit(value, maxBytes)
  }
  if (value instanceof ArrayBuffer) {
    return enforceConvertedLimit(new Uint8Array(value), maxBytes)
  }
  if (value && typeof value === 'object' && 'arrayBuffer' in value) {
    const declaredBytes = declaredBinaryPayloadBytes(value)
    if (declaredBytes === null || declaredBytes > maxBytes) {
      throw new Error(OVERSIZED_BINARY_MESSAGE)
    }
    const blob = value as { arrayBuffer: () => Promise<ArrayBuffer> }
    let buffer: ArrayBuffer
    try {
      buffer = await blob.arrayBuffer()
    } catch {
      return null
    }
    return enforceConvertedLimit(new Uint8Array(buffer), maxBytes)
  }
  if (typeof FileReader !== 'undefined' && value instanceof Blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (!(reader.result instanceof ArrayBuffer)) {
          resolve(null)
          return
        }
        try {
          resolve(enforceConvertedLimit(new Uint8Array(reader.result), maxBytes))
        } catch (error) {
          reject(error)
        }
      }
      reader.onerror = () => resolve(null)
      reader.readAsArrayBuffer(value)
    })
  }
  return null
}

function declaredBinaryPayloadBytes(value: object): number | null {
  for (const key of ['size', 'byteLength'] as const) {
    if (!(key in value)) {
      continue
    }
    const candidate = (value as Record<string, unknown>)[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      return candidate
    }
  }
  return null
}

function enforceConvertedLimit(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (bytes.byteLength > maxBytes) {
    throw new Error(OVERSIZED_BINARY_MESSAGE)
  }
  return bytes
}
