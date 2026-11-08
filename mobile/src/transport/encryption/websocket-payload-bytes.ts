import { decodeMobileCanonicalBase64 } from './mobile-paired-e2ee-primitives'

// Opt into our react-native patch: binary messages then arrive as `{ base64 }`, skipping base64-js.
export function receiveBinaryAsBase64(socket: WebSocket): WebSocket {
  return Object.assign(socket, { orcaBinaryAsBase64: true })
}

export async function websocketPayloadToUint8(value: unknown): Promise<Uint8Array | null> {
  if (isBase64Binary(value)) {
    return decodeMobileCanonicalBase64(value.base64)
  }
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (value && typeof value === 'object' && 'arrayBuffer' in value) {
    const blob = value as { arrayBuffer: () => Promise<ArrayBuffer> }
    try {
      return new Uint8Array(await blob.arrayBuffer())
    } catch {
      return null
    }
  }
  if (typeof FileReader !== 'undefined' && value instanceof Blob) {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        resolve(reader.result instanceof ArrayBuffer ? new Uint8Array(reader.result) : null)
      }
      reader.onerror = () => resolve(null)
      reader.readAsArrayBuffer(value)
    })
  }
  return null
}

function isBase64Binary(value: unknown): value is { base64: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'base64' in value &&
    typeof value.base64 === 'string'
  )
}
