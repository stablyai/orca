// mirrors src/shared/e2ee-crypto.ts; keep semantics in sync.
// Browser flavor: no Buffer (the .ehpk WebView doesn't have one) — tweetnacl uses
// crypto.getRandomValues natively in browsers, and framing goes through atob/btoa instead
// of Node's Buffer base64 codec. Wire bytes (nonce || box ciphertext) are identical.
import nacl from 'tweetnacl'

export function generateKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const kp = nacl.box.keyPair()
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublicKey, ourSecretKey)
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

export function encryptText(plaintext: string, sharedKey: Uint8Array): string {
  const messageBytes = new TextEncoder().encode(plaintext)
  return uint8ToBase64(encryptToBundle(messageBytes, sharedKey))
}

export function decryptText(encrypted: string, sharedKey: Uint8Array): string | null {
  const bundle = base64ToUint8(encrypted)
  const plaintext = decryptBytes(bundle, sharedKey)
  return plaintext ? new TextDecoder().decode(plaintext) : null
}

function encryptToBundle(plaintext: Uint8Array, sharedKey: Uint8Array): Uint8Array {
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

  const nonce = bundle.subarray(0, nacl.box.nonceLength)
  const ciphertext = bundle.subarray(nacl.box.nonceLength)
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey)

  return plaintext ? plaintext : null
}
