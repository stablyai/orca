import { strToU8, zipSync } from 'fflate'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildTestCrx, generateCrxTestKey, type CrxTestKey } from './browser-extension-crx-fixture'
import { extensionIdFromPublicKey, verifyCrx3 } from './browser-extension-crx'

const archive = Buffer.from(zipSync({ 'manifest.json': strToU8('{"name":"x","version":"1"}') }))
let rsaKey: CrxTestKey
let otherRsaKey: CrxTestKey
let ecKey: CrxTestKey

beforeAll(() => {
  rsaKey = generateCrxTestKey('rsa')
  otherRsaKey = generateCrxTestKey('rsa')
  ecKey = generateCrxTestKey('ecdsa')
})

function verify(crx: Buffer, expectedExtensionId: string, requirePublisherProof = false) {
  return verifyCrx3(crx, { expectedExtensionId, requirePublisherProof })
}

describe('verifyCrx3', () => {
  it('accepts a package signed by the key its id is derived from', () => {
    const id = extensionIdFromPublicKey(rsaKey.publicKeyDer)
    const crx = buildTestCrx({ archive, developerKey: rsaKey, signers: [rsaKey] })

    const verified = verify(crx, id)

    expect(id).toMatch(/^[a-p]{32}$/)
    expect(verified.extensionId).toBe(id)
    expect(verified.publicKey.equals(rsaKey.publicKeyDer)).toBe(true)
    expect(verified.archive.equals(archive)).toBe(true)
  })

  it('accepts ECDSA developer keys alongside other valid proofs', () => {
    const id = extensionIdFromPublicKey(ecKey.publicKeyDer)
    const crx = buildTestCrx({ archive, developerKey: ecKey, signers: [otherRsaKey, ecKey] })

    expect(verify(crx, id).publicKey.equals(ecKey.publicKeyDer)).toBe(true)
  })

  it('rejects a package whose archive changed after signing', () => {
    const id = extensionIdFromPublicKey(rsaKey.publicKeyDer)
    const crx = buildTestCrx({ archive, developerKey: rsaKey, signers: [rsaKey] })
    crx[crx.length - 5] ^= 0xff

    expect(() => verify(crx, id)).toThrow('CRX signature does not verify')
  })

  it('rejects a package for a different extension id', () => {
    const crx = buildTestCrx({ archive, developerKey: rsaKey, signers: [rsaKey] })

    expect(() => verify(crx, extensionIdFromPublicKey(otherRsaKey.publicKeyDer))).toThrow(
      'CRX belongs to a different extension'
    )
  })

  it('rejects a package that claims an id but is signed only by another key', () => {
    const id = extensionIdFromPublicKey(rsaKey.publicKeyDer)
    const crx = buildTestCrx({ archive, developerKey: rsaKey, signers: [otherRsaKey] })

    expect(() => verify(crx, id)).toThrow('CRX is not signed by its own key')
  })

  it('rejects any proof that fails, even when the developer proof is valid', () => {
    const id = extensionIdFromPublicKey(rsaKey.publicKeyDer)
    const crx = buildTestCrx({
      archive,
      developerKey: rsaKey,
      signers: [rsaKey, otherRsaKey],
      tagFor: (key) => (key === otherRsaKey ? 3 : 2)
    })

    expect(() => verify(crx, id)).toThrow('CRX signature key does not match its algorithm')
  })

  it('requires the Chrome Web Store publisher proof for store installs', () => {
    const id = extensionIdFromPublicKey(rsaKey.publicKeyDer)
    const crx = buildTestCrx({ archive, developerKey: rsaKey, signers: [rsaKey] })

    expect(() => verify(crx, id, true)).toThrow('CRX is not signed by the Chrome Web Store')
  })

  it('rejects files that are not CRX3', () => {
    const id = extensionIdFromPublicKey(rsaKey.publicKeyDer)
    const crx = buildTestCrx({ archive, developerKey: rsaKey, signers: [rsaKey] })
    const crx2 = Buffer.from(crx)
    crx2.writeUInt32LE(2, 4)

    expect(() => verify(archive, id)).toThrow('Not a CRX file')
    expect(() => verify(crx2, id)).toThrow('Only CRX3 packages are supported')
    expect(() => verify(crx.subarray(0, 40), id)).toThrow('Malformed CRX header')
  })
})
