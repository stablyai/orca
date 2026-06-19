import { describe, expect, it } from 'vitest'
import {
  generateKeyPair,
  deriveSharedKey,
  encrypt,
  decrypt,
  encryptBytes,
  decryptBytes
} from './e2ee-crypto'

describe('e2ee-crypto', () => {
  it('encrypt/decrypt round-trips with shared key', () => {
    const server = generateKeyPair()
    const client = generateKeyPair()

    const serverShared = deriveSharedKey(server.secretKey, client.publicKey)
    const clientShared = deriveSharedKey(client.secretKey, server.publicKey)

    const message = '{"id":"rpc-1","method":"status.get"}'
    const encrypted = encrypt(message, clientShared)
    const decrypted = decrypt(encrypted, serverShared)

    expect(decrypted).toBe(message)
  })

  it('decrypt returns null with wrong key', () => {
    const server = generateKeyPair()
    const client = generateKeyPair()
    const attacker = generateKeyPair()

    const clientShared = deriveSharedKey(client.secretKey, server.publicKey)
    const attackerShared = deriveSharedKey(attacker.secretKey, server.publicKey)

    const encrypted = encrypt('secret data', clientShared)
    expect(decrypt(encrypted, attackerShared)).toBeNull()
  })

  it('each encryption produces unique ciphertext (random nonce)', () => {
    const server = generateKeyPair()
    const client = generateKeyPair()
    const shared = deriveSharedKey(client.secretKey, server.publicKey)

    const message = 'same message'
    const a = encrypt(message, shared)
    const b = encrypt(message, shared)

    expect(a).not.toBe(b)
  })

  it('handles empty string', () => {
    const server = generateKeyPair()
    const client = generateKeyPair()
    const shared = deriveSharedKey(client.secretKey, server.publicKey)

    const encrypted = encrypt('', shared)
    expect(decrypt(encrypted, shared)).toBe('')
  })

  it('handles unicode content', () => {
    const server = generateKeyPair()
    const client = generateKeyPair()
    const shared = deriveSharedKey(client.secretKey, server.publicKey)

    const message = '日本語テスト 🎉 émojis'
    const encrypted = encrypt(message, shared)
    expect(decrypt(encrypted, shared)).toBe(message)
  })

  it('decrypt returns null for truncated data', () => {
    const shared = deriveSharedKey(generateKeyPair().secretKey, generateKeyPair().publicKey)
    expect(decrypt('dG9vc2hvcnQ=', shared)).toBeNull()
  })

  it('decrypt returns null for tampered data', () => {
    const server = generateKeyPair()
    const client = generateKeyPair()
    const shared = deriveSharedKey(client.secretKey, server.publicKey)

    const encrypted = encrypt('hello', shared)
    const bytes = Buffer.from(encrypted, 'base64')
    bytes[bytes.length - 1] ^= 0xff
    const tampered = bytes.toString('base64')

    expect(decrypt(tampered, shared)).toBeNull()
  })

  it('encrypt/decrypt round-trips raw bytes for binary terminal frames', () => {
    const server = generateKeyPair()
    const client = generateKeyPair()
    const serverShared = deriveSharedKey(server.secretKey, client.publicKey)
    const clientShared = deriveSharedKey(client.secretKey, server.publicKey)
    const payload = new Uint8Array([0, 1, 2, 127, 128, 255])

    const encrypted = encryptBytes(payload, clientShared)
    const decrypted = decryptBytes(encrypted, serverShared)

    expect(decrypted).toEqual(payload)
  })
})
