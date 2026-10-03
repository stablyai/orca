// A multiple of three keeps padding confined to the final chunk.
const BASE64_BINARY_CHUNK_BYTES = 8190

export function encodeBase64Bytes(bytes: Uint8Array): string {
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
