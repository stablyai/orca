import { describe, expect, it } from 'vitest'
import { normalizeAccountMfa } from './profile-cloud-mfa-service'

const API = 'https://cloud.orca.dev'

describe('normalizeAccountMfa', () => {
  it('keeps the status and a setup link on Orca Cloud', () => {
    expect(
      normalizeAccountMfa({ mfa: 'off', setupUrl: `${API}/v1/account/security` }, API)
    ).toEqual({ mfa: 'off', setupUrl: `${API}/v1/account/security` })
    expect(normalizeAccountMfa({ mfa: 'on', setupUrl: `${API}/x` }, `${API}/`).mfa).toBe('on')
  })

  it.each([
    ['another site', { mfa: 'off', setupUrl: 'https://evil.example/v1/account/security' }],
    ['a look-alike host', { mfa: 'off', setupUrl: 'https://cloud.orca.dev.evil.example/' }],
    ['plain http', { mfa: 'off', setupUrl: 'http://cloud.orca.dev/v1/account/security' }],
    ['credentials in the link', { mfa: 'off', setupUrl: 'https://user:pw@cloud.orca.dev/' }],
    ['a script link', { mfa: 'off', setupUrl: 'javascript:alert(1)' }],
    ['no link', { mfa: 'off' }],
    ['an unknown status', { mfa: 'pending', setupUrl: `${API}/v1/account/security` }],
    ['a boolean status', { mfa: true, setupUrl: `${API}/v1/account/security` }],
    ['nothing', null]
  ])('refuses %s', (_name, body) => {
    expect(() => normalizeAccountMfa(body, API)).toThrow('invalid_orca_account_mfa')
  })
})
