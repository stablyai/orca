import { describe, expect, it } from 'vitest'
import { hashMobileRelayCredential } from './mobile-relay-credential-hash'

describe('mobile relay credential hash', () => {
  it('hashes the base64url wire token text rather than its decoded bytes', () => {
    expect(hashMobileRelayCredential('BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc')).toBe(
      '3Ev4DHdHPRMPoN6GukAY_pi7IUAF5qWJHRK6kURvnoE'
    )
  })
})
