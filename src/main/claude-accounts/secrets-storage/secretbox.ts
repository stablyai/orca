import sodium from 'sodium-native'

export const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES // 24

export type EncryptedSecret = { ciphertext: Buffer; nonce: Buffer }

export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  const plainBuf = Buffer.from(plaintext, 'utf8')
  const nonce = Buffer.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  const cipher = Buffer.alloc(plainBuf.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(cipher, plainBuf, nonce, key)
  return { ciphertext: cipher, nonce }
}

export function decryptSecret(ciphertext: Buffer, nonce: Buffer, key: Buffer): string {
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`Nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}.`)
  }
  const plain = Buffer.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
  const ok = sodium.crypto_secretbox_open_easy(plain, ciphertext, nonce, key)
  if (!ok) {
    throw new Error(
      'Failed to decrypt or verify secret — wrong passphrase or corrupted ciphertext.'
    )
  }
  return plain.toString('utf8')
}
