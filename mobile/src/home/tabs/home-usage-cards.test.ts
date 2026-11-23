import { describe, expect, it } from 'vitest'
import { decodeAccountsSnapshot } from '../../accounts/accounts-snapshot'
import { selectHomeUsageCards } from './home-usage-cards'

function claudeReading(usedPercent: number, readingAccount?: unknown) {
  return {
    provider: 'claude',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok',
    ...(readingAccount ? { usageMetadata: { readingAccount } } : {})
  }
}

const ACCOUNTS = [
  { id: 'a', email: 'a@example.com' },
  { id: 'b', email: 'b@example.com', managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' }
]

function snapshot(
  active: unknown,
  activeAccountId: string | null = 'a',
  { accounts = ACCOUNTS, inactive = [] }: { accounts?: unknown[]; inactive?: unknown[] } = {}
) {
  return decodeAccountsSnapshot({
    claude: { accounts, activeAccountId },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: active,
      codex: null,
      inactiveClaudeAccounts: inactive,
      inactiveCodexAccounts: []
    }
  })
}

const sessionOf = (cards: ReturnType<typeof selectHomeUsageCards>, accountId: string | null) =>
  cards.find((card) => card.accountId === accountId)?.limits?.session?.usedPercent ?? null

describe('selectHomeUsageCards', () => {
  it('keeps a snapshot with a malformed account stamp, attributing nothing', () => {
    const cards = selectHomeUsageCards(
      snapshot(claudeReading(60, { accountId: 'a', runtime: 'moon' })),
      'claude'
    )

    expect(sessionOf(cards, 'a')).toBeNull()
  })
})
