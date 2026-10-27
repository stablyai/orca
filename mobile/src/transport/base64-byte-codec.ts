// A multiple of three keeps padding confined to the final chunk.
const BASE64_BINARY_CHUNK_BYTES = 8190

export function encodeBase64Bytes(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    return ''
  }
  if ('toBase64' in bytes && typeof bytes.toBase64 === 'function') {
    return bytes.toBase64()
  }
  const encoded: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_BINARY_CHUNK_BYTES) {
    const end = Math.min(offset + BASE64_BINARY_CHUNK_BYTES, bytes.byteLength)
    let binary = ''
    for (let index = offset; index < end; index += 1) {
      binary += String.fromCharCode(bytes[index]!)
    }
    encoded.push(btoa(binary))
  }
  return encoded.join('')
}

export function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Reject forgiving atob forms (missing padding, whitespace, stray bits) in O(1); re-encoding large frames is costly on Hermes.
export function decodeCanonicalBase64Bytes(value: string): Uint8Array | null {
  let bytes: Uint8Array
  try {
    bytes = decodeBase64Bytes(value)
  } catch {
    return null
  }
  if (value.length % 4 !== 0) {
    return null
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  // Why: the length equation rules out whitespace, which atob strips.
  if (bytes.length !== (value.length / 4) * 3 - padding) {
    return null
  }
  if (padding === 0) {
    return bytes
  }
  const lastSextet = BASE64_ALPHABET.indexOf(value[value.length - padding - 1]!)
  return (lastSextet & (padding === 2 ? 0x0f : 0x03)) === 0 ? bytes : null
}
