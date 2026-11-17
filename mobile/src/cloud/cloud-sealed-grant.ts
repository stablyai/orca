import { gcm } from '@noble/ciphers/aes'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import nacl from 'tweetnacl'
import {
  openSealedGrant,
  type OpenedGrant,
  type SealedGrant,
  type SealedGrantPrimitives
} from '../../../src/shared/cloud-workspaces/sealed-grant'

// Hermes has no WebCrypto, so the shared openers (grants, read snapshots) run on pure-JS primitives.
export const CLOUD_SEALED_PRIMITIVES: SealedGrantPrimitives = {
  x25519: (secretKey, publicKey) =>
    nacl.scalarMult(new Uint8Array(secretKey), new Uint8Array(publicKey)),
  x25519PublicKey: (secretKey) => nacl.scalarMult.base(new Uint8Array(secretKey)),
  hkdfSha256: (ikm, salt, info, length) => hkdf(sha256, ikm, salt, info, length),
  aesGcmDecrypt: (key, nonce, ciphertext, aad) => gcm(key, nonce, aad).decrypt(ciphertext)
}

export function createGrantRecipientKey(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const pair = nacl.box.keyPair()
  return { publicKey: new Uint8Array(pair.publicKey), secretKey: new Uint8Array(pair.secretKey) }
}

/** Opens a grant the VM sealed to this phone's one-time key; a runtime-scope offer is refused. */
export function openCloudSealedGrant(
  sealed: SealedGrant,
  grantId: string,
  recipientSecretKey: Uint8Array
): Promise<OpenedGrant> {
  return openSealedGrant(sealed, grantId, recipientSecretKey, CLOUD_SEALED_PRIMITIVES, 'mobile')
}
