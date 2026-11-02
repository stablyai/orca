// Legacy NaCl framing prefixes ciphertext with a 24-byte nonce; text messages base64-encode that bundle.
import nacl from 'tweetnacl'
import * as ExpoCrypto from 'expo-crypto'
import { decodeBase64Bytes, encodeBase64Bytes } from './base64-byte-codec'

// Provide native secure randomness for Hermes environments without crypto.getRandomValues.
nacl.setPRNG((_x: Uint8Array, n: number) => {
  const bytes = ExpoCrypto.getRandomBytes(n)
  _x.set(bytes)
})

// Normalize Hermes/native typed-array prototypes for tweetnacl’s instanceof checks.
function u8(x: Uint8Array): Uint8Array {
  return new Uint8Array(x)
}

export function generateKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const kp = nacl.box.keyPair()
  return { publicKey: u8(kp.publicKey), secretKey: u8(kp.secretKey) }
}

export function randomBytes(length: number): Uint8Array {
  return u8(nacl.randomBytes(length))
}

export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return u8(nacl.box.before(u8(peerPublicKey), u8(ourSecretKey)))
}

export function publicKeyFromBase64(b64: string): Uint8Array {
  const key = decodeBase64Bytes(b64)
  if (key.length !== 32) {
    throw new Error(
      `Invalid public key: expected 32 bytes, got ${key.length} from "${b64.slice(0, 20)}..."`
    )
  }
  return key
}

export function publicKeyToBase64(key: Uint8Array): string {
  return encodeBase64Bytes(key)
}

export function encrypt(plaintext: string, sharedKey: Uint8Array): string {
  const messageBytes = u8(new TextEncoder().encode(plaintext))
  return encodeBase64Bytes(encryptBytes(messageBytes, sharedKey))
}

export function decrypt(encrypted: string, sharedKey: Uint8Array): string | null {
  const bundle = decodeBase64Bytes(encrypted)
  const plaintext = decryptBytes(bundle, sharedKey)
  return plaintext ? new TextDecoder().decode(plaintext) : null
}

export function encryptBytes(
  plaintext: Uint8Array,
  sharedKey: Uint8Array
): Uint8Array<ArrayBuffer> {
  const nonce = u8(nacl.randomBytes(nacl.box.nonceLength))
  const ciphertext = nacl.box.after(u8(plaintext), nonce, u8(sharedKey))

  const bundle = new Uint8Array(nonce.length + ciphertext.length)
  bundle.set(nonce)
  bundle.set(ciphertext, nonce.length)

  return bundle
}

export function decryptBytes(bundle: Uint8Array, sharedKey: Uint8Array): Uint8Array | null {
  if (bundle.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    return null
  }

  const nonce = u8(bundle.subarray(0, nacl.box.nonceLength))
  const ciphertext = u8(bundle.subarray(nacl.box.nonceLength))
  const plaintext = nacl.box.open.after(ciphertext, nonce, u8(sharedKey))

  if (!plaintext) {
    return null
  }

  return u8(plaintext)
}
