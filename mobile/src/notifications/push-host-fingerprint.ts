import { sha256 } from '@noble/hashes/sha256'

// Match the gateway’s base64url SHA-256 public-key prefix (16 chars), as relay-http-client derives it, then map back through stored keys.
// Keep this pure: existing encoder modules pull in native crypto, host storage or tweetnacl.

const HOST_FINGERPRINT_LENGTH = 16

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Unreadable stored keys cannot shadow a later valid match.
export function deriveHostFingerprint(publicKeyB64: string): string | null {
  const publicKey = decodeBase64(publicKeyB64)
  if (!publicKey || publicKey.length !== 32) {
    return null
  }
  return encodeBase64Url(sha256(publicKey)).slice(0, HOST_FINGERPRINT_LENGTH)
}

export function resolveHostIdForFingerprint(
  fingerprint: string,
  hosts: readonly { readonly id: string; readonly publicKeyB64: string }[]
): string | null {
  if (fingerprint.length !== HOST_FINGERPRINT_LENGTH) {
    return null
  }
  for (const host of hosts) {
    if (deriveHostFingerprint(host.publicKeyB64) === fingerprint) {
      return host.id
    }
  }
  return null
}
