import { describe, expect, it } from 'vitest'

import { isPlausibleHostedLogin } from './git-username'

describe('isPlausibleHostedLogin', () => {
  it('accepts ordinary GitHub logins', () => {
    expect(isPlausibleHostedLogin('octocat')).toBe(true)
    expect(isPlausibleHostedLogin('mona-lisa')).toBe(true)
    expect(isPlausibleHostedLogin('a')).toBe(true)
    expect(isPlausibleHostedLogin('a'.repeat(39))).toBe(true)
  })

  it('accepts Enterprise Managed User logins, which carry a _shortcode suffix', () => {
    expect(isPlausibleHostedLogin('octocat_acme')).toBe(true)
    expect(isPlausibleHostedLogin('mona-lisa_acme')).toBe(true)
    expect(isPlausibleHostedLogin(`${'a'.repeat(34)}_acme`)).toBe(true)
  })

  it('still rejects leading or trailing separators, double hyphens and non-tokens', () => {
    expect(isPlausibleHostedLogin('_acme')).toBe(false)
    expect(isPlausibleHostedLogin('octocat_')).toBe(false)
    expect(isPlausibleHostedLogin('-octocat')).toBe(false)
    expect(isPlausibleHostedLogin('octocat-')).toBe(false)
    expect(isPlausibleHostedLogin('octo--cat')).toBe(false)
    expect(isPlausibleHostedLogin('{"message":"API rate limit exceeded"}')).toBe(false)
    expect(isPlausibleHostedLogin('a'.repeat(40))).toBe(false)
    for (const login of [
      'octocat_acme/branch',
      'octocat_acme\\branch',
      'octocat_acme\nother',
      'octocat_acme.lock',
      'octocat_acme other'
    ]) {
      expect(isPlausibleHostedLogin(login)).toBe(false)
    }
  })
})
