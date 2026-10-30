import { sha256 } from '@noble/hashes/sha256'

// Hash serialized bearer text, not decoded random bytes, to match the relay’s stored credential digest.
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
