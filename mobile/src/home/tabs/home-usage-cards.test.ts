import { describe, expect, it } from 'vitest'
import { decodeAccountsSnapshot, type ProviderRateLimits } from '../../accounts/accounts-snapshot'
import { selectHomeUsageCards } from './home-usage-cards'

function claudeReading(usedPercent: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

function savedAccountSelected(systemDefault: ProviderRateLimits) {
  return decodeAccountsSnapshot({
    claude: {
      accounts: [{ id: 'saved', email: 'saved@example.com' }],
      activeAccountId: 'saved'
    },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: claudeReading(80),
      codex: null,
      inactiveClaudeAccounts: [
        {
          accountId: 'claude-system-default',
          rateLimits: systemDefault,
          updatedAt: 1,
          isFetching: false
        }
      ],
      inactiveCodexAccounts: []
    }
  })
}

function cardSummaries(cards: ReturnType<typeof selectHomeUsageCards>) {
  return cards.map((card) => [card.accountId, card.active, card.limits?.session?.usedPercent])
}

describe('selectHomeUsageCards', () => {
  it("lists System default after the selected account once the host has System default's reading", () => {
    expect(
      cardSummaries(selectHomeUsageCards(savedAccountSelected(claudeReading(37)), 'claude'))
    ).toEqual([
      ['saved', true, 80],
      [null, false, 37]
    ])
  })
})
