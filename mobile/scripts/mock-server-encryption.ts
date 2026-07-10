import nacl from 'tweetnacl'

export type E2EEState = {
  sharedKey: Uint8Array
  deviceToken: string | null
  authenticated: boolean
}

export function deriveSharedKey(ourSecret: Uint8Array, peerPublic: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublic, ourSecret)
}

export function e2eeEncrypt(plaintext: string, sharedKey: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const msg = new TextEncoder().encode(plaintext)
  const ciphertext = nacl.box.after(msg, nonce, sharedKey)
  const bundle = new Uint8Array(nonce.length + ciphertext.length)
  bundle.set(nonce)
  bundle.set(ciphertext, nonce.length)
  return Buffer.from(bundle).toString('base64')
}

export function e2eeDecrypt(encrypted: string, sharedKey: Uint8Array): string | null {
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
