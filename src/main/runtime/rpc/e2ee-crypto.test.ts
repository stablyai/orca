import { describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import {
  generateKeyPair,
  deriveSharedKey,
  decrypt,
  decryptBytes
} from '../../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import { MOBILE_E2EE_LEGACY_FIXTURE } from '../../../shared/remote-runtime/e2ee/mobile-e2ee-legacy-fixtures'

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

  it('decrypt returns null for truncated data', () => {
    const shared = deriveSharedKey(generateKeyPair().secretKey, generateKeyPair().publicKey)
    expect(decrypt('dG9vc2hvcnQ=', shared)).toBeNull()
  })
})
