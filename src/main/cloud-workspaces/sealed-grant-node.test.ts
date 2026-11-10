import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign
} from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { openSealedGrant, type SealedGrant } from '../../shared/cloud-workspaces/sealed-grant'
import {
  ed25519Verify,
  generateGrantRecipientKey,
  nodeSealedGrantPrimitives
} from './sealed-grant-node'
import { generateTestSigner } from './read-snapshot-sealer.test-fixture'

const GRANT_ID = 'grt_0123456789abcdef01234567'

/** The VM's grant sealer (sealed-grant.ts header), independent of the opener. */
function sealGrantForTest(payload: unknown, recipientPublicKeyB64: string): SealedGrant {
  const recipientPublic = Buffer.from(recipientPublicKeyB64, 'base64')
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralPublic = Buffer.from(ephemeral.publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: recipientPublic.toString('base64url') },
      format: 'jwk'
    })
  })
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([ephemeralPublic, recipientPublic]),
      Buffer.from('orca-cloud-grant-v1', 'utf8'),
      32
    )
  )
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(`orca-cloud-grant-v1:${GRANT_ID}`, 'utf8'))
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final(),
    cipher.getAuthTag()
  ])
  return {
    v: 1,
    ephemeralPublicKeyB64: ephemeralPublic.toString('base64'),
    nonceB64: nonce.toString('base64'),
    ciphertextB64: ct.toString('base64')
  }
}

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
