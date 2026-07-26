import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { MOBILE_E2EE_LEGACY_FIXTURE } from '../../../src/shared/mobile-e2ee-legacy-fixtures'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(9)
}))

import { decrypt, decryptBytes, deriveSharedKey } from './e2ee'

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
})

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
}
