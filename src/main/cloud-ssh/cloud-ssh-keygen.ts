// ed25519 key pairs in OpenSSH's own formats, made with Node's crypto: no ssh-keygen dependency
// (Windows may not have one) and nothing touches the user's ~/.ssh keys.
import { generateKeyPairSync, randomBytes } from 'node:crypto'

export type CloudSshKeyPair = {
  /** `-----BEGIN OPENSSH PRIVATE KEY-----` (openssh-key-v1, unencrypted), for IdentityFile. */
  privateKey: string
  /** `ssh-ed25519 <base64> <comment>`, one line. */
  publicKey: string
}

const KEY_TYPE = 'ssh-ed25519'

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  return Buffer.concat([length, bytes])
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(value)
  return out
}

export function generateCloudSshKeyPair(comment: string): CloudSshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url')
  return encodeOpenSshKeyPair(seed, pub, comment)
}

/** Exposed for tests: deterministic from a seed + public key. */
export function encodeOpenSshKeyPair(seed: Buffer, pub: Buffer, comment: string): CloudSshKeyPair {
  if (seed.length !== 32 || pub.length !== 32) {
    throw new Error('ed25519 keys are 32 bytes')
  }
  const publicBlob = Buffer.concat([sshString(KEY_TYPE), sshString(pub)])
  const check = randomBytes(4).readUInt32BE()
  let secret = Buffer.concat([
    uint32(check),
    uint32(check),
    sshString(KEY_TYPE),
    sshString(pub),
    // OpenSSH stores the 64-byte expanded form: seed followed by the public key.
    sshString(Buffer.concat([seed, pub])),
    sshString(comment)
  ])
  // Unencrypted keys pad to the 8-byte "none" cipher block with 1, 2, 3, ...
  const padding = Array.from({ length: (8 - (secret.length % 8)) % 8 }, (_, i) => i + 1)
  secret = Buffer.concat([secret, Buffer.from(padding)])
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    uint32(1),
    sshString(publicBlob),
    sshString(secret)
  ])
  const lines = body.toString('base64').match(/.{1,70}/g) ?? []
  return {
    privateKey: [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      ...lines,
      '-----END OPENSSH PRIVATE KEY-----',
      ''
    ].join('\n'),
    publicKey: `${KEY_TYPE} ${publicBlob.toString('base64')} ${comment}`
  }
}
