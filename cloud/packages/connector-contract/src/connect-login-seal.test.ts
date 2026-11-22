import { describe, expect, it } from 'vitest'
import { createConnectLoginKey, openConnectLogin, sealConnectLogin } from './connect-login-seal.js'
import { CONNECT_LOGIN_KEY_PATTERN } from './connect-messages.js'

const login = {
  accessToken: 'lin_oauth_access',
  refreshToken: 'lin_refresh',
  expiresAt: 1_800_000_000_000,
  clientId: 'client-1'
}

describe('connect login seal', () => {
  it('opens only with the key it was sealed to', () => {
    const key = createConnectLoginKey()
    expect(key.publicKey).toMatch(CONNECT_LOGIN_KEY_PATTERN)
    const sealed = sealConnectLogin(key.publicKey, login)
    expect(sealed).not.toContain('lin_oauth_access')
    expect(openConnectLogin(key, sealed)).toEqual(login)
    expect(openConnectLogin(createConnectLoginKey(), sealed)).toBeNull()
  })

  it('refuses tampered or malformed ciphertext', () => {
    const key = createConnectLoginKey()
    const sealed = Buffer.from(sealConnectLogin(key.publicKey, login), 'base64url')
    const last = sealed.length - 1
    sealed.writeUInt8(sealed.readUInt8(last) ^ 1, last)
    expect(openConnectLogin(key, sealed.toString('base64url'))).toBeNull()
    expect(openConnectLogin(key, 'short')).toBeNull()
  })

  it('refuses to seal to anything but an X25519 key', () => {
    expect(() => sealConnectLogin('not-a-key', login)).toThrow()
  })
})
