// Unit 6: E2EE wire framing for MockOrcaServer, mirroring mobile/src/transport/e2ee.ts's wire
// bytes exactly — base64(24B nonce ‖ box ciphertext) for text frames, raw nonce‖box for binary
// (spec S6 point 8). Split out of mock-orca-server.ts to keep that file under the line ceiling.
import nacl from 'tweetnacl'

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

// NOTE: throws (via atob) on malformed base64 — kept as-is since other callers (e.g. the hello
// handshake's public key decode) rely on this signature. decryptText below is the one caller that
// must fail closed instead of throwing, so it wraps its own call in try/catch.
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function encryptBytes(plaintext: Uint8Array, sharedKey: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box.after(plaintext, nonce, sharedKey)
  const bundle = new Uint8Array(nonce.length + ciphertext.length)
  bundle.set(nonce)
  bundle.set(ciphertext, nonce.length)
  return bundle
}

export function encryptText(plaintext: string, sharedKey: Uint8Array): string {
  return bytesToBase64(encryptBytes(new TextEncoder().encode(plaintext), sharedKey))
}

/** Fails closed (returns null) on a malformed frame — a garbled/truncated base64 payload must
 *  not throw out of atob and escape handleAuth / handlePostAuthText uncaught. */
export function decryptText(encoded: string, sharedKey: Uint8Array): string | null {
  let bundle: Uint8Array
  try {
    bundle = base64ToBytes(encoded)
  } catch {
    return null
  }
  if (bundle.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    return null
  }
  const nonce = bundle.slice(0, nacl.box.nonceLength)
  const ciphertext = bundle.slice(nacl.box.nonceLength)
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey)
  return plaintext ? new TextDecoder().decode(plaintext) : null
}
