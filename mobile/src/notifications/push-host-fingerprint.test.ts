import { describe, expect, it } from 'vitest'
import { deriveHostFingerprint, resolveHostIdForFingerprint } from './push-host-fingerprint'

const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index)
const publicKeyB64 = Buffer.from(publicKey).toString('base64')

describe('deriveHostFingerprint', () => {
  it('matches base64url(sha256(publicKey)) truncated to 16 chars', () => {
    const fingerprint = deriveHostFingerprint(publicKeyB64)

    expect(fingerprint).toBe('Yw3NKWbEM2aRElRI')
    expect(fingerprint).toHaveLength(16)
  })

  it('produces url-safe characters only, so a fingerprint survives a JSON payload', () => {
    // This digest prefix contains both '/' and '+' before URL normalization.
    const dense = new Uint8Array(32).fill(87)
    const fingerprint = deriveHostFingerprint(Buffer.from(dense).toString('base64'))

    expect(fingerprint).toBe('3G2G1n4fGgJbM_r-')
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
    expect(resolveHostIdForFingerprint('Yw3NKWbEM2aRElRI', hosts)).toBe('host-1')
  })

  it('returns null for a fingerprint no paired host derives', () => {
    expect(resolveHostIdForFingerprint('0123456789abcdef', hosts)).toBeNull()
  })

  it('rejects a fingerprint of the wrong length', () => {
    expect(resolveHostIdForFingerprint('Yw3NKWbEM2aRElRI'.slice(0, 8), hosts)).toBeNull()
  })
})
