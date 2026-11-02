import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeDiscordPublicKey, verifyDiscordSignature } from './discord-signature.js'

// Scheme: https://docs.discord.com/developers/interactions/overview (X-Signature-Ed25519 over
// X-Signature-Timestamp + raw body, with the application's public key).
describe('verifyDiscordSignature', () => {
  const pair = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const x = publicKey.export({ format: 'jwk' }).x ?? ''
    return { privateKey, hex: Buffer.from(x, 'base64url').toString('hex') }
  }
  const ours = pair()
  const publicKey = decodeDiscordPublicKey(ours.hex)
  const body = '{"type":1}'
  const signed = (timestamp: string, raw = body, privateKey = ours.privateKey) =>
    sign(null, Buffer.from(timestamp + raw), privateKey).toString('hex')
  const check = (signature: string, timestamp = '1800000000', nowMs = 1_800_000_000_000) =>
    verifyDiscordSignature({ publicKey, timestamp, signature, rawBody: body, nowMs })

  it('accepts the application key’s signature within five minutes', () => {
    expect(check(signed('1800000000'))).toBe(true)
    expect(check(signed('1800000000'), '1800000000', 1_800_000_300_000)).toBe(true)
  })

  it('refuses another key, another body, a stale timestamp, or a malformed signature', () => {
    expect(check(signed('1800000000', body, pair().privateKey))).toBe(false)
    expect(check(signed('1800000000', '{"type":2}'))).toBe(false)
    expect(check(signed('1800000000'), '1800000000', 1_800_000_301_000)).toBe(false)
    expect(check(signed('1800000000'), '1800000001')).toBe(false)
    expect(check('zz')).toBe(false)
    expect(
      verifyDiscordSignature({
        publicKey,
        timestamp: undefined,
        signature: signed('1'),
        rawBody: body,
        nowMs: 0
      })
    ).toBe(false)
  })

  it('refuses a public key that is not 32 bytes of hex', () => {
    expect(() => decodeDiscordPublicKey('abc')).toThrow()
    expect(() => decodeDiscordPublicKey(`${ours.hex.slice(0, 62)}zz`)).toThrow()
  })
})
