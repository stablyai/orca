import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes
} from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createGrantRecipientKey, openCloudSealedGrant } from './cloud-sealed-grant'

// Seals the way the VM does (node:crypto), so the phone's pure-JS opener is checked against it.
function sealLikeVm(recipientPublicKey: Uint8Array, grantId: string, plaintext: string) {
  const eph = generateKeyPairSync('x25519')
  const ephRaw = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const recipient = createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(recipientPublicKey).toString('base64url') },
    format: 'jwk'
  })
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient })
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([ephRaw, recipientPublicKey]),
      'orca-cloud-grant-v1',
      32
    )
  )
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(`orca-cloud-grant-v1:${grantId}`))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return {
    v: 1 as const,
    ephemeralPublicKeyB64: ephRaw.toString('base64'),
    nonceB64: nonce.toString('base64'),
    ciphertextB64: ct.toString('base64')
  }
}

const OFFER = JSON.stringify({
  pairingUrl: 'orca://pair?code=abc',
  deviceId: 'dev-1',
  scope: 'mobile'
})

describe('openCloudSealedGrant', () => {
  it('opens a grant sealed by the VM for this grant id', async () => {
    const recipient = createGrantRecipientKey()
    const sealed = sealLikeVm(recipient.publicKey, 'grant_1', OFFER)
    await expect(openCloudSealedGrant(sealed, 'grant_1', recipient.secretKey)).resolves.toEqual({
      pairingUrl: 'orca://pair?code=abc',
      deviceId: 'dev-1',
      scope: 'mobile'
    })
  })

  it('refuses a box replayed under another grant id', async () => {
    const recipient = createGrantRecipientKey()
    const sealed = sealLikeVm(recipient.publicKey, 'grant_1', OFFER)
    await expect(openCloudSealedGrant(sealed, 'grant_2', recipient.secretKey)).rejects.toThrow()
  })

  it('refuses a runtime-scope offer even when it decrypts', async () => {
    const recipient = createGrantRecipientKey()
    const sealed = sealLikeVm(
      recipient.publicKey,
      'g',
      JSON.stringify({ pairingUrl: 'orca://pair?code=x', deviceId: 'd', scope: 'runtime' })
    )
    await expect(openCloudSealedGrant(sealed, 'g', recipient.secretKey)).rejects.toThrow()
  })
})
