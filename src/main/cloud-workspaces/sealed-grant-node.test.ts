import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { openSealedGrant } from '../../shared/cloud-workspaces/sealed-grant'
import {
  ed25519Verify,
  generateGrantRecipientKey,
  nodeSealedGrantPrimitives
} from './sealed-grant-node'
import { generateTestSigner } from './read-snapshot-sealer.test-fixture'
import { GRANT_ID, sealGrantForTest } from './sealed-grant-sealer.test-fixture'

const base = { pairingUrl: 'orca://pair?code=abc', deviceId: 'dev_1', scope: 'runtime' }

describe('openSealedGrant read signer', () => {
  it('round-trips the workspace snapshot signer', async () => {
    const recipient = generateGrantRecipientKey()
    const signer = generateTestSigner().publicKeyB64
    const opened = await openSealedGrant(
      sealGrantForTest({ ...base, readSignerPublicKeyB64: signer }, recipient.publicKeyB64),
      GRANT_ID,
      recipient.secretKey,
      nodeSealedGrantPrimitives,
      'runtime'
    )
    expect(opened.readSignerPublicKeyB64).toBe(signer)
  })

  it.each([['not base64!'], ['AAAA'], [42], [null]])(
    'drops a malformed signer (%s) and still opens the grant',
    async (bad) => {
      const recipient = generateGrantRecipientKey()
      const opened = await openSealedGrant(
        sealGrantForTest({ ...base, readSignerPublicKeyB64: bad }, recipient.publicKeyB64),
        GRANT_ID,
        recipient.secretKey,
        nodeSealedGrantPrimitives,
        'runtime'
      )
      expect(opened.pairingUrl).toBe(base.pairingUrl)
      expect('readSignerPublicKeyB64' in opened).toBe(false)
    }
  )
})

describe('ed25519Verify', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const raw = new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url'))
  const message = new TextEncoder().encode('hello')
  const signature = new Uint8Array(sign(null, message, privateKey))

  it('accepts a valid signature over a raw 32-byte key', () => {
    expect(ed25519Verify(raw, message, signature)).toBe(true)
  })

  it('rejects another message, a wrong-size key or signature', () => {
    expect(ed25519Verify(raw, new TextEncoder().encode('hellO'), signature)).toBe(false)
    expect(ed25519Verify(raw.subarray(0, 31), message, signature)).toBe(false)
    expect(ed25519Verify(raw, message, signature.subarray(0, 63))).toBe(false)
  })
})
