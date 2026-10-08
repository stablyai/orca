import { sha256 } from '@noble/hashes/sha256'

// Why: a push arrives from the gateway, so it can only name the host by something
// both sides derive independently — base64url(sha256(hostPublicKey)) truncated to
// 16 chars, identical to deriveRelayHostId in
// src/main/runtime/relay/relay-http-client.ts. The phone maps it back to its own
// hostId by re-deriving over each stored host's publicKeyB64.
//
// Base64 is inlined rather than imported (same call as mobile-relay-credential-hash.ts):
// the only shared encoders live in modules that drag in tweetnacl, expo-crypto, or
// the host store, none of which a pure derivation should need.

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

/** Null when the stored key is unreadable, so a corrupt host entry can't shadow a real match. */
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
