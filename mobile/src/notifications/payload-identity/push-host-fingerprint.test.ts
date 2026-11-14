import { describe, expect, it } from 'vitest'
import { resolveHostIdForFingerprint } from './push-host-fingerprint'

const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index)
const publicKeyB64 = Buffer.from(publicKey).toString('base64')

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
})
