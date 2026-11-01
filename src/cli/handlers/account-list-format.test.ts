import { describe, expect, it } from 'vitest'
import type { CodexRateLimitAccountsState } from '../../shared/managed-account-types'
import { formatAccountsBlock } from './account-list-format'

describe('formatAccountsBlock', () => {
  it('names the System default login on an empty roster, so a server says which login it runs', () => {
    expect(
      formatAccountsBlock('Claude', {
        accounts: [],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} },
        systemDefaultEmail: 'me@example.test'
      })
    ).toBe('No managed Claude accounts.\n  system  System default: me@example.test (active)')
  })

  it('still lists System default when the host could not read its login', () => {
    expect(
      formatAccountsBlock('Claude', {
        accounts: [],
        activeAccountId: null
      })
    ).toBe('No managed Claude accounts.\n  system  System default (active)')
  })

  it('marks System default active only while no saved account is selected for the host', () => {
    const accounts = [{ id: 'a', email: 'a@example.test' }]
    expect(
      formatAccountsBlock('Claude', {
        accounts,
        activeAccountId: 'a',
        activeAccountIdsByRuntime: { host: 'a', wsl: {} },
        systemDefaultEmail: 'me@example.test'
      })
    ).toBe(
      'Managed Claude accounts (1):\n  system  System default: me@example.test\n  a@example.test (active)'
    )
    expect(
      formatAccountsBlock('Claude', {
        accounts,
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'a' } }
      })
    ).toBe(
      'Managed Claude accounts (1):\n  system  System default (active)\n  a@example.test (active)'
    )
  })

  it("names the Codex System default from the host's resolved ~/.codex identity", () => {
    const state: CodexRateLimitAccountsState = {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} },
      systemDefault: {
        email: 'codex@example.test',
        hasAuth: true,
        authKind: 'oauth',
        providerAccountId: null,
        workspaceLabel: null
      }
    }
    expect(formatAccountsBlock('Codex', state)).toBe(
      'No managed Codex accounts.\n  system  System default: codex@example.test (active)'
    )
  })

  it('uses the host selection ahead of a legacy active ID for the System default row', () => {
    expect(
      formatAccountsBlock('Claude', {
        accounts: [{ id: 'wsl', email: 'wsl@example.test' }],
        activeAccountId: 'wsl',
        activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl' } }
      })
    ).toBe(
      'Managed Claude accounts (1):\n  system  System default (active)\n  wsl@example.test (active)'
    )
  })

  it('handles an unresolved Codex identity without printing a null email', () => {
    expect(
      formatAccountsBlock('Codex', {
        accounts: [],
        activeAccountId: null,
        systemDefault: { email: null }
      })
    ).toBe('No managed Codex accounts.\n  system  System default (active)')
  })

  it('keeps the sign-in hint on a saved account whose folder holds no login', () => {
    expect(
      formatAccountsBlock('Claude', {
        accounts: [{ id: 'b', email: 'b@example.test', needsSignIn: true }],
        activeAccountId: null
      })
    ).toBe(
      'Managed Claude accounts (1):\n  system  System default (active)\n  b@example.test (sign in again in Orca Settings > AI Provider Accounts)'
    )
  })
})
