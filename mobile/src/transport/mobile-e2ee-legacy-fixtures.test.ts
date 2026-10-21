import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { MOBILE_E2EE_LEGACY_FIXTURE } from '../../../src/shared/mobile-e2ee-legacy-fixtures'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(9)
}))

import { decrypt, decryptBytes, deriveSharedKey, encrypt } from './e2ee'

describe('mobile legacy E2EE fixtures', () => {
  it('matches the captured desktop key and text/binary frames', () => {
    const fixture = MOBILE_E2EE_LEGACY_FIXTURE
    const server = nacl.box.keyPair.fromSecretKey(fixture.serverSecretKey)
    const client = nacl.box.keyPair.fromSecretKey(fixture.clientSecretKey)
    const shared = deriveSharedKey(client.secretKey, server.publicKey)

    expect(hex(shared)).toBe(fixture.sharedKeyHex)
    expect(decrypt(fixture.authFrameB64, shared)).toBe(fixture.authPlaintext)
    expect(decryptBytes(fromHex(fixture.binaryFrameHex), shared)).toEqual(fixture.binaryPlaintext)
  })

  it('preserves large legacy text frames and permissive base64 decoding', () => {
    const fixture = MOBILE_E2EE_LEGACY_FIXTURE
    const server = nacl.box.keyPair.fromSecretKey(fixture.serverSecretKey)
    const client = nacl.box.keyPair.fromSecretKey(fixture.clientSecretKey)
    const shared = deriveSharedKey(client.secretKey, server.publicKey)
    const plaintext = 'legacy π '.repeat(2000)
    const nonce = new Uint8Array(nacl.box.nonceLength).fill(9)
    const ciphertext = nacl.box.after(new TextEncoder().encode(plaintext), nonce, shared)
    const expected = Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]).toString('base64')
    expect(encrypt(plaintext, shared)).toBe(expected)
    expect(decrypt(` ${expected}\n`, shared)).toBe(plaintext)
    expect(() => decrypt('!invalid base64', shared)).toThrow()
  })
})

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
}
