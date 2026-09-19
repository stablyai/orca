import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha256'
import { deriveHostFingerprint, resolveHostIdForFingerprint } from './push-host-fingerprint'

// Why Buffer here: it computes the same value through a completely different
// base64 path than the module's btoa/replace, so the vector is a real cross-check
// of the derivation the desktop and gateway independently perform.
function expectedFingerprint(publicKey: Uint8Array): string {
  return Buffer.from(sha256(publicKey)).toString('base64url').slice(0, 16)
}

const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index)
const publicKeyB64 = Buffer.from(publicKey).toString('base64')

describe('deriveHostFingerprint', () => {
  it('matches base64url(sha256(publicKey)) truncated to 16 chars', () => {
    const fingerprint = deriveHostFingerprint(publicKeyB64)

    expect(fingerprint).toBe(expectedFingerprint(publicKey))
    expect(fingerprint).toHaveLength(16)
  })

  it('produces url-safe characters only, so a fingerprint survives a JSON payload', () => {
    // 0xff bytes are what push '+' and '/' into a standard base64 digest.
    const dense = new Uint8Array(32).fill(0xff)
    const fingerprint = deriveHostFingerprint(Buffer.from(dense).toString('base64'))

    expect(fingerprint).toBe(expectedFingerprint(dense))
    expect(fingerprint).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  it.each([
    ['a key of the wrong length', Buffer.from(new Uint8Array(16)).toString('base64')],
    ['text that is not base64 at all', '!!!not base64!!!'],
    ['an empty key', '']
  ])('returns null for %s', (_label, value) => {
    expect(deriveHostFingerprint(value)).toBeNull()
  })
})

describe('resolveHostIdForFingerprint', () => {
  const other = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
  const hosts = [
    { id: 'host-corrupt', publicKeyB64: 'not-a-key' },
    { id: 'host-other', publicKeyB64: Buffer.from(other).toString('base64') },
    { id: 'host-1', publicKeyB64 }
  ]

  it('maps a push fingerprint back to the paired host id', () => {
    expect(resolveHostIdForFingerprint(expectedFingerprint(publicKey), hosts)).toBe('host-1')
  })

  it('returns null for a fingerprint no paired host derives', () => {
    expect(resolveHostIdForFingerprint('0123456789abcdef', hosts)).toBeNull()
  })

  it('rejects a fingerprint of the wrong length before hashing anything', () => {
    expect(
      resolveHostIdForFingerprint(expectedFingerprint(publicKey).slice(0, 8), hosts)
    ).toBeNull()
  })
})
