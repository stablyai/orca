// node:crypto primitives for openSealedGrant (desktop main process).
import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync
} from 'node:crypto'
import {
  bytesToBase64,
  type SealedGrantPrimitives
} from '../../shared/cloud-workspaces/sealed-grant'

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

function privateKeyFor(secret: Uint8Array, publicKey: Uint8Array) {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', d: b64url(secret), x: b64url(publicKey) },
    format: 'jwk'
  })
}

function publicKeyOf(secret: Uint8Array): Uint8Array {
  // Node derives the public half when only `d` is given via PKCS#8; JWK import needs `x`, so go through DER.
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b656e04220420', 'hex'),
    Buffer.from(secret)
  ])
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
  const jwk = createPublicKey(key).export({ format: 'jwk' })
  return new Uint8Array(Buffer.from(jwk.x!, 'base64url'))
}

export const nodeSealedGrantPrimitives: SealedGrantPrimitives = {
  x25519PublicKey: publicKeyOf,
  x25519(secret, peer) {
    const shared = diffieHellman({
      privateKey: privateKeyFor(secret, publicKeyOf(secret)),
      publicKey: createPublicKey({
        key: { kty: 'OKP', crv: 'X25519', x: b64url(peer) },
        format: 'jwk'
      })
    })
    return new Uint8Array(shared)
  },
  hkdfSha256(ikm, salt, info, length) {
    return new Uint8Array(hkdfSync('sha256', ikm, salt, info, length))
  },
  aesGcmDecrypt(key, nonce, ciphertext, aad) {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(ciphertext.subarray(-16))
    return new Uint8Array(
      Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()])
    )
  }
}

/** One-shot recipient key per grant request: the secret never leaves this process's memory. */
export function generateGrantRecipientKey(): { secretKey: Uint8Array; publicKeyB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const secret = new Uint8Array(Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url'))
  const pub = new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url'))
  return { secretKey: secret, publicKeyB64: bytesToBase64(pub) }
}
