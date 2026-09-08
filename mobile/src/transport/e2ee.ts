// Why: E2EE primitives for the mobile side. Uses tweetnacl for Curve25519 ECDH
// key exchange and XSalsa20-Poly1305 authenticated encryption. JSON RPC uses
// base64([24-byte nonce][ciphertext]) over WebSocket text frames; terminal
// stream frames use the raw byte bundle.
import nacl from 'tweetnacl'
import * as ExpoCrypto from 'expo-crypto'

// Why: Hermes (React Native's JS engine) lacks crypto.getRandomValues,
// which tweetnacl requires. expo-crypto provides a native secure RNG
// that works in Expo Go without a custom dev build.
nacl.setPRNG((_x: Uint8Array, n: number) => {
  const bytes = ExpoCrypto.getRandomBytes(n)
  _x.set(bytes)
})

// Why: tweetnacl uses `instanceof Uint8Array` checks internally. On Hermes,
// values from native modules (expo-crypto), TextEncoder, or typed array
// operations can return objects that fail this check despite being
// functionally identical. Wrapping with `new Uint8Array(x)` guarantees
// the correct prototype chain.
function u8(x: Uint8Array): Uint8Array {
  return new Uint8Array(x)
}

export function generateKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const kp = nacl.box.keyPair()
  return { publicKey: u8(kp.publicKey), secretKey: u8(kp.secretKey) }
}

export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return u8(nacl.box.before(u8(peerPublicKey), u8(ourSecretKey)))
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function publicKeyFromBase64(b64: string): Uint8Array {
  const key = base64ToUint8(b64)
  if (key.length !== 32) {
    throw new Error(
      `Invalid public key: expected 32 bytes, got ${key.length} from "${b64.slice(0, 20)}..."`
    )
  }
  return key
}

export function publicKeyToBase64(key: Uint8Array): string {
  return uint8ToBase64(key)
}

export function encrypt(plaintext: string, sharedKey: Uint8Array): string {
  const messageBytes = u8(new TextEncoder().encode(plaintext))
  return uint8ToBase64(encryptBytes(messageBytes, sharedKey))
}

export function decrypt(encrypted: string, sharedKey: Uint8Array): string | null {
  const bundle = base64ToUint8(encrypted)
  const plaintext = decryptBytes(bundle, sharedKey)
  return plaintext ? new TextDecoder().decode(plaintext) : null
}

export function encryptBytes(plaintext: Uint8Array, sharedKey: Uint8Array): Uint8Array {
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
