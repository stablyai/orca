// Test-only grant sealer: the VM's construction (sealed-grant.ts header) with node:crypto.
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes
} from 'node:crypto'
import type { SealedGrant } from '../../shared/cloud-workspaces/sealed-grant'

export const GRANT_ID = 'grt_0123456789abcdef01234567'

/** The VM's grant sealer (sealed-grant.ts header), independent of the opener. */
export function sealGrantForTest(
  payload: unknown,
  recipientPublicKeyB64: string,
  grantId: string = GRANT_ID
): SealedGrant {
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
  cipher.setAAD(Buffer.from(`orca-cloud-grant-v1:${grantId}`, 'utf8'))
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
