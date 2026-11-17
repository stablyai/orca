// Test-only sealer: the VM's construction (see read-snapshot.ts header) with node:crypto, so the
// desktop opener is checked against an independent implementation rather than itself.
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject
} from 'node:crypto'
import type { SealedReadSnapshot } from '../../shared/cloud-workspaces/read-snapshot'

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

function gcm(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: string): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
}

export function sealReadSnapshotForTest(args: {
  payload: unknown
  workspaceId: string
  snapshotId: string
  readerPublicKeyB64: string
  keyId: string
  storedAt?: number
  /** The VM's Ed25519 signing key; unsigned (an older VM) when absent. */
  signer?: TestSigner
}): SealedReadSnapshot {
  const { workspaceId, snapshotId, keyId } = args
  const dek = randomBytes(32)
  const nonce = randomBytes(12)
  const body = gcm(
    dek,
    nonce,
    Buffer.from(JSON.stringify(args.payload), 'utf8'),
    `orca-cloud-read-v1:${workspaceId}:${snapshotId}`
  )
  const readerPublic = Buffer.from(args.readerPublicKeyB64, 'base64')
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralPublic = Buffer.from(ephemeral.publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: readerPublic.toString('base64url') },
      format: 'jwk'
    })
  })
  const kek = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([ephemeralPublic, readerPublic]),
      Buffer.from('orca-cloud-read-wrap-v1', 'utf8'),
      32
    )
  )
  const wrapNonce = randomBytes(12)
  const wrapped = gcm(
    kek,
    wrapNonce,
    dek,
    `orca-cloud-read-wrap-v1:${workspaceId}:${snapshotId}:${keyId}`
  )
  const signature = args.signer
    ? {
        publicKeyB64: args.signer.publicKeyB64,
        signatureB64: b64(
          sign(
            null,
            Buffer.concat([
              Buffer.from(
                `orca-cloud-read-sig-v1:${workspaceId}:${snapshotId}:${b64(nonce)}:`,
                'utf8'
              ),
              body
            ]),
            args.signer.privateKey
          )
        )
      }
    : undefined
  return {
    ...(signature ? { signature } : {}),
    v: 1,
    snapshotId,
    workspaceId,
    storedAt: args.storedAt ?? 1_000,
    nonceB64: b64(nonce),
    ciphertextB64: b64(body),
    recipient: {
      keyId,
      ephemeralPublicKeyB64: b64(ephemeralPublic),
      nonceB64: b64(wrapNonce),
      wrappedKeyB64: b64(wrapped)
    }
  }
}

export type TestSigner = { privateKey: KeyObject; publicKeyB64: string }

/** A VM's per-workspace Ed25519 signing key (raw public key, std base64). */
export function generateTestSigner(): TestSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey,
    publicKeyB64: Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString(
      'base64'
    )
  }
}
