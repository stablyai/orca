// Why: shared E2EE primitives for the desktop side. Wraps tweetnacl to provide
// encrypt/decrypt with the NaCl box format: [24-byte nonce][ciphertext], encoded
// as base64 for transmission over WebSocket text frames.
import nacl from 'tweetnacl'

export function generateKeyPair(): nacl.BoxKeyPair {
  return nacl.box.keyPair()
}

export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublicKey, ourSecretKey)
}

export function encrypt(plaintext: string, sharedKey: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const messageBytes = new TextEncoder().encode(plaintext)
  const ciphertext = nacl.box.after(messageBytes, nonce, sharedKey)

  const bundle = new Uint8Array(nonce.length + ciphertext.length)
  bundle.set(nonce)
  bundle.set(ciphertext, nonce.length)

  return Buffer.from(bundle).toString('base64')
}

export function decrypt(encrypted: string, sharedKey: Uint8Array): string | null {
  const bundle = Uint8Array.from(Buffer.from(encrypted, 'base64'))
  if (bundle.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    return null
  }

  const nonce = bundle.slice(0, nacl.box.nonceLength)
  const ciphertext = bundle.slice(nacl.box.nonceLength)
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey)

  if (!plaintext) {
    return null
  }

  return new TextDecoder().decode(plaintext)
}
