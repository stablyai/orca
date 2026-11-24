import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes
} from 'node:crypto'
import { z } from 'zod'
import { CONNECT_LOGIN_KEY_PATTERN } from './connect-messages.js'

// A Linear connect hands the person's own login to the Mac that started it, sealed to a key only
// that Mac holds: the cloud keeps ciphertext it can't open, and only until the trip is redeemed.

export const ConnectLoginSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  // Epoch ms.
  expiresAt: z.number().positive(),
  // The app the login was issued to; a PKCE login refreshes with it alone.
  clientId: z.string().min(1)
})
export type ConnectLogin = z.infer<typeof ConnectLoginSchema>

const INFO = Buffer.from('orca connect login v1')
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

const publicKeyOf = (raw: string): KeyObject => {
  if (!CONNECT_LOGIN_KEY_PATTERN.test(raw)) {
    throw new Error('not an X25519 key')
  }
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' })
}

const rawOf = (key: KeyObject): string => {
  const { x } = key.export({ format: 'jwk' })
  if (typeof x !== 'string') {
    throw new Error('not an X25519 key')
  }
  return x
}

const keyFor = (privateKey: KeyObject, publicKey: KeyObject, salt: Buffer): Buffer =>
  Buffer.from(
    hkdfSync('sha256', diffieHellman({ privateKey, publicKey }), salt, INFO, KEY_BYTES)
  )

/** The Mac's one-trip key pair: the public half for the start, the private half kept in memory. */
export function createConnectLoginKey(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('x25519')
  const { d } = pair.privateKey.export({ format: 'jwk' })
  if (typeof d !== 'string') {
    throw new Error('not an X25519 key')
  }
  return { publicKey: rawOf(pair.publicKey), privateKey: d }
}

export function sealConnectLogin(recipient: string, login: ConnectLogin): string {
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralRaw = Buffer.from(rawOf(ephemeral.publicKey), 'base64url')
  const key = keyFor(
    ephemeral.privateKey,
    publicKeyOf(recipient),
    Buffer.concat([ephemeralRaw, Buffer.from(recipient, 'base64url')])
  )
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const sealed = Buffer.concat([cipher.update(JSON.stringify(login), 'utf8'), cipher.final()])
  return Buffer.concat([ephemeralRaw, iv, cipher.getAuthTag(), sealed]).toString('base64url')
}

/** The login, or null for anything this key didn't seal. */
export function openConnectLogin(
  key: { publicKey: string; privateKey: string },
  sealed: string
): ConnectLogin | null {
  try {
    const bytes = Buffer.from(sealed, 'base64url')
    const ephemeralRaw = bytes.subarray(0, KEY_BYTES)
    const iv = bytes.subarray(KEY_BYTES, KEY_BYTES + IV_BYTES)
    const tag = bytes.subarray(KEY_BYTES + IV_BYTES, KEY_BYTES + IV_BYTES + TAG_BYTES)
    const privateKey = createPrivateKey({
      key: { kty: 'OKP', crv: 'X25519', x: key.publicKey, d: key.privateKey },
      format: 'jwk'
    })
    const derived = keyFor(
      privateKey,
      publicKeyOf(ephemeralRaw.toString('base64url')),
      Buffer.concat([ephemeralRaw, Buffer.from(key.publicKey, 'base64url')])
    )
    const decipher = createDecipheriv('aes-256-gcm', derived, iv)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([
      decipher.update(bytes.subarray(KEY_BYTES + IV_BYTES + TAG_BYTES)),
      decipher.final()
    ])
    return ConnectLoginSchema.safeParse(JSON.parse(plain.toString('utf8'))).data ?? null
  } catch {
    return null
  }
}
