import { describe, expect, it } from 'vitest'
import type { AccountProviderRateLimits, AccountsSnapshot } from '../../accounts/accounts-snapshot'
import { selectHomeUsageCards } from './home-usage-cards'

function limits(
  provider: 'claude' | 'codex',
  usedPercent: number,
  overrides: Partial<AccountProviderRateLimits> = {}
): AccountProviderRateLimits {
  return {
    provider,
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1_000,
    error: null,
    status: 'ok',
    ...overrides
  }
}

function snapshot(overrides: {
  claude?: Partial<AccountsSnapshot['claude']>
  codex?: Partial<AccountsSnapshot['codex']>
  rateLimits?: Partial<AccountsSnapshot['rateLimits']>
}): AccountsSnapshot {
  return {
    claude: { accounts: [], activeAccountId: null, ...overrides.claude },
    codex: { accounts: [], activeAccountId: null, ...overrides.codex },
    rateLimits: {
      claude: null,
      codex: null,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [],
      ...overrides.rateLimits
    }
  }
}

describe('selectHomeUsageCards', () => {
  it('lists the active managed account first, with no System default, and inactive usage from its own fetch', () => {
    const cards = selectHomeUsageCards(
      snapshot({
        claude: {
          accounts: [
            { id: 'a', email: 'a@example.com', organizationName: 'Acme' },
            { id: 'b', email: 'b@example.com' }
          ],
          activeAccountId: 'b'
        },
        rateLimits: {
          claude: limits('claude', 70),
          inactiveClaudeAccounts: [
            { accountId: 'a', rateLimits: limits('claude', 10), updatedAt: 1, isFetching: true }
          ]
        }
      }),
      'claude'
    )
    expect(
      cards.map((card) => [
        card.email,
        card.subtitle,
        card.active,
        card.limits?.session?.usedPercent,
        card.fetching
      ])
    ).toEqual([
      ['b@example.com', null, true, 70, false],
      ['a@example.com', 'Acme', false, 10, true]
    ])
  })

  it('reads the Codex active account for the rate-limit runtime target', () => {
    const cards = selectHomeUsageCards(
      snapshot({
        codex: {
          accounts: [
            { id: 'host', email: 'host@example.com', updatedAt: 1, workspaceLabel: 'Team' },
            { id: 'wsl', email: 'wsl@example.com', updatedAt: 1 }
          ],
          activeAccountId: 'host',
          activeAccountIdsByRuntime: { host: 'host', wsl: { Ubuntu: 'wsl' } }
        },
        rateLimits: { codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' } }
      }),
      'codex'
    )
    expect(cards.map((card) => [card.accountId, card.subtitle, card.active])).toEqual([
      ['wsl', null, true],
      ['host', 'Team', false]
    ])
  })
})
