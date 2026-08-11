import { sha256 } from '@noble/hashes/sha256'

// Why: the relay stores a digest of the serialized base64url bearer, not the
// random bytes it encodes, so every installer must hash the wire token text.
export function hashMobileRelayCredential(token: string): string {
  return encodeBase64Url(sha256(new TextEncoder().encode(token)))
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
