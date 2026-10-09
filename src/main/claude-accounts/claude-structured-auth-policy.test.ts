import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { CLAUDE_AUTH_ENV_VARS, isHostManagedClaudeAccount } from './environment'
import { claudeStructuredAuthPolicyForSettings } from './claude-structured-auth-policy'

const HOST_ACCOUNT = { id: 'host-a', managedAuthRuntime: 'host' } as ClaudeManagedAccount
const WSL_ACCOUNT = { id: 'wsl-b', managedAuthRuntime: 'wsl' } as ClaudeManagedAccount
const LEGACY_ACCOUNT = { id: 'legacy-c' } as ClaudeManagedAccount

function settings(
  overrides: Partial<
    Pick<
      GlobalSettings,
      | 'claudeManagedAccounts'
      | 'activeClaudeManagedAccountId'
      | 'activeClaudeManagedAccountIdsByRuntime'
    >
  >
): Parameters<typeof claudeStructuredAuthPolicyForSettings>[0] {
  return {
    claudeManagedAccounts: [HOST_ACCOUNT, WSL_ACCOUNT, LEGACY_ACCOUNT],
    activeClaudeManagedAccountId: null,
    ...overrides
  } as Parameters<typeof claudeStructuredAuthPolicyForSettings>[0]
}

describe('isHostManagedClaudeAccount', () => {
  it('is false when no managed account is selected', () => {
    expect(isHostManagedClaudeAccount([HOST_ACCOUNT], null)).toBe(false)
    expect(isHostManagedClaudeAccount([HOST_ACCOUNT], undefined)).toBe(false)
    expect(isHostManagedClaudeAccount([HOST_ACCOUNT], '')).toBe(false)
  })

  it('is true for a host-managed account', () => {
    expect(isHostManagedClaudeAccount([HOST_ACCOUNT, WSL_ACCOUNT], 'host-a')).toBe(true)
  })

  it('is true for an account with no explicit runtime (the legacy host shape)', () => {
    expect(isHostManagedClaudeAccount([LEGACY_ACCOUNT], 'legacy-c')).toBe(true)
  })

  it('is false for a WSL-managed account', () => {
    expect(isHostManagedClaudeAccount([HOST_ACCOUNT, WSL_ACCOUNT], 'wsl-b')).toBe(false)
  })

  it('is true for a selected id no account list explains', () => {
    expect(isHostManagedClaudeAccount([HOST_ACCOUNT], 'deleted-d')).toBe(true)
    expect(isHostManagedClaudeAccount(undefined, 'deleted-d')).toBe(true)
    expect(isHostManagedClaudeAccount([], 'deleted-d')).toBe(true)
  })
})

describe('claudeStructuredAuthPolicyForSettings', () => {
  it('reads the host runtime selection, not the legacy flat field alone', () => {
    expect(
      claudeStructuredAuthPolicyForSettings(
        settings({
          activeClaudeManagedAccountId: 'host-a',
          activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
        })
      )
    ).toEqual({ account: 'managed' })
  })

  it('names a host account pinned by runtime selection', () => {
    expect(
      claudeStructuredAuthPolicyForSettings(
        settings({ activeClaudeManagedAccountIdsByRuntime: { host: 'host-a', wsl: {} } })
      )
    ).toEqual({ account: 'managed' })
  })

  it('names System default when no account is selected', () => {
    expect(claudeStructuredAuthPolicyForSettings(settings({}))).toEqual({
      account: 'system'
    })
  })

  it('ignores a WSL-only selection: the structured child is always a native host process', () => {
    expect(
      claudeStructuredAuthPolicyForSettings(
        settings({
          activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-b' } }
        })
      )
    ).toEqual({ account: 'system' })
  })
})

describe('the Anthropic auth variables Orca keeps out of its own processes', () => {
  it('covers every Anthropic auth variable the terminal path knows about', () => {
    // Only Orca's own process env and a `--version` probe drop these; launches never do.
    expect([...CLAUDE_AUTH_ENV_VARS]).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK'
    ])
  })
})
