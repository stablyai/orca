import { describe, expect, it } from 'vitest'
import { resolveCodexLaunchAccount } from './codex-launch-account'

const accounts = [
  { id: 'account-a', email: 'Same@Example.com' },
  { id: 'account-b', email: 'same@example.com' },
  { id: 'account-c', email: 'Unique@Example.com' },
  { id: 'account-wsl', email: 'unique@example.com', managedHomeRuntime: 'wsl' as const }
]

describe('native Codex launch account selectors', () => {
  it('resolves exact ids even when their email is ambiguous', () => {
    expect(resolveCodexLaunchAccount(accounts, 'account-b')).toEqual({
      provider: 'codex',
      requested: 'account-b',
      effective: { id: 'account-b', email: 'same@example.com' }
    })
  })

  it('resolves case-insensitive emails only within the supported host lane', () => {
    expect(resolveCodexLaunchAccount(accounts, ' UNIQUE@EXAMPLE.COM ')).toEqual({
      provider: 'codex',
      requested: 'unique@example.com',
      effective: { id: 'account-c', email: 'Unique@Example.com' }
    })
  })

  it.each(['system', 'SYSTEM', 'System default'])(
    'resolves %s explicitly to the system account',
    (selector) => {
      expect(resolveCodexLaunchAccount(accounts, selector)).toEqual({
        provider: 'codex',
        requested: 'system',
        effective: { id: null, email: null }
      })
    }
  )

  it('gives exact ids precedence over the reserved system selector', () => {
    expect(
      resolveCodexLaunchAccount([{ id: 'system', email: 'id@example.com' }], 'system').effective.id
    ).toBe('system')
  })

  it('refuses ambiguous email with exact ids as the remedy', () => {
    expect(() => resolveCodexLaunchAccount(accounts, 'SAME@example.com')).toThrow(
      /Ambiguous.*account-a, account-b/
    )
  })

  it.each(['missing', 'ACCOUNT-C'])('refuses unknown or inexact ids: %s', (selector) => {
    expect(() => resolveCodexLaunchAccount(accounts, selector)).toThrow(
      'No managed Codex account matches'
    )
  })

  it('refuses an exact WSL account id', () => {
    expect(() => resolveCodexLaunchAccount(accounts, 'account-wsl')).toThrow(
      'WSL accounts are unsupported'
    )
  })

  it.each(['', ' ', 'id\nsecret', 'id\u0000secret', 'x'.repeat(513)])(
    'refuses malformed selectors',
    (selector) => {
      expect(() => resolveCodexLaunchAccount(accounts, selector)).toThrow('--account requires')
    }
  )
})
