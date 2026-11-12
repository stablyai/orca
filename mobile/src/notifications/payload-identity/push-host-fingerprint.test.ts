import { describe, expect, it } from 'vitest'
import { deriveHostFingerprint, resolveHostIdForFingerprint } from './push-host-fingerprint'

const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index)
const publicKeyB64 = Buffer.from(publicKey).toString('base64')

describe('deriveHostFingerprint', () => {
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
