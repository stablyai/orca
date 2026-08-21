import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import {
  generateKeyPair,
  deriveSharedKey,
  encrypt,
  decrypt,
  encryptBytes,
  decryptBytes,
  MAX_E2EE_ENCRYPTED_BASE64_CHARACTERS,
  publicKeyFromBase64
} from './e2ee-crypto'
import { MOBILE_E2EE_LEGACY_FIXTURE } from '../../../shared/mobile-e2ee-legacy-fixtures'

describe('e2ee-crypto', () => {
  it('preserves the captured legacy key and text/binary frame bytes', () => {
    const fixture = MOBILE_E2EE_LEGACY_FIXTURE
    const server = nacl.box.keyPair.fromSecretKey(fixture.serverSecretKey)
    const client = nacl.box.keyPair.fromSecretKey(fixture.clientSecretKey)
    const shared = deriveSharedKey(client.secretKey, server.publicKey)

    expect(Buffer.from(server.publicKey).toString('base64')).toBe(fixture.serverPublicKeyB64)
    expect(Buffer.from(client.publicKey).toString('base64')).toBe(fixture.clientPublicKeyB64)
    expect(Buffer.from(shared).toString('hex')).toBe(fixture.sharedKeyHex)
    expect(decrypt(fixture.authFrameB64, shared)).toBe(fixture.authPlaintext)
    expect(decryptBytes(Buffer.from(fixture.binaryFrameHex, 'hex'), shared)).toEqual(
      fixture.binaryPlaintext
    )
  })

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

  it('rejects oversized encoded inputs before base64 decoding', () => {
    const shared = deriveSharedKey(generateKeyPair().secretKey, generateKeyPair().publicKey)
    const decode = vi.spyOn(Buffer, 'from')

    expect(() => publicKeyFromBase64('A'.repeat(45))).toThrow('encoded value is too large')
    expect(decrypt('A'.repeat(MAX_E2EE_ENCRYPTED_BASE64_CHARACTERS + 1), shared)).toBeNull()
    expect(decode).not.toHaveBeenCalled()
    decode.mockRestore()
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
