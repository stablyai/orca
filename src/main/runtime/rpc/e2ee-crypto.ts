// Why: shared E2EE primitives for the desktop side. Wraps tweetnacl to provide
// encrypt/decrypt with the NaCl box format: [24-byte nonce][ciphertext]. JSON
// RPC uses base64 text frames; terminal streams use the raw byte bundle.
import nacl from 'tweetnacl'

export function generateKeyPair(): nacl.BoxKeyPair {
  return nacl.box.keyPair()
}

export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublicKey, ourSecretKey)
}

export function encrypt(plaintext: string, sharedKey: Uint8Array): string {
  const messageBytes = new TextEncoder().encode(plaintext)
  return Buffer.from(encryptBytes(messageBytes, sharedKey)).toString('base64')
}

export function decrypt(encrypted: string, sharedKey: Uint8Array): string | null {
  const bundle = Uint8Array.from(Buffer.from(encrypted, 'base64'))
  const plaintext = decryptBytes(bundle, sharedKey)
  return plaintext ? new TextDecoder().decode(plaintext) : null
}

export function encryptBytes(
  plaintext: Uint8Array<ArrayBufferLike>,
  sharedKey: Uint8Array
): Uint8Array {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box.after(plaintext, nonce, sharedKey)

  const bundle = new Uint8Array(nonce.length + ciphertext.length)
  bundle.set(nonce)
  bundle.set(ciphertext, nonce.length)

  return bundle
}

export function decryptBytes(bundle: Uint8Array, sharedKey: Uint8Array): Uint8Array | null {
  if (bundle.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    return null
  }

  const nonce = bundle.slice(0, nacl.box.nonceLength)
  const ciphertext = bundle.slice(nacl.box.nonceLength)
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey)

  if (!plaintext) {
    return null
  }

  return plaintext
}
