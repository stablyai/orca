import { describe, expect, it } from 'vitest'
import { isAppBoundEncryptedCookie } from './browser-cookie-import'

function encryptedCookie(versionPrefix: string): Buffer {
  return Buffer.concat([Buffer.from(versionPrefix), Buffer.from([0xde, 0xad, 0xbe, 0xef])])
}

describe('isAppBoundEncryptedCookie', () => {
  it('detects the v20 app-bound prefix', () => {
    expect(isAppBoundEncryptedCookie(encryptedCookie('v20'))).toBe(true)
  })

  it.each(['v10', 'v11'])('leaves the decryptable %s prefix alone', (prefix) => {
    expect(isAppBoundEncryptedCookie(encryptedCookie(prefix))).toBe(false)
  })

  it('does not treat a plaintext value as app-bound', () => {
    expect(isAppBoundEncryptedCookie(Buffer.from('session=abc123'))).toBe(false)
  })

  it.each([
    ['empty', Buffer.alloc(0)],
    ['shorter than the prefix', Buffer.from('v2')]
  ])('handles a buffer %s without throwing', (_label, buffer) => {
    expect(isAppBoundEncryptedCookie(buffer)).toBe(false)
  })
})
