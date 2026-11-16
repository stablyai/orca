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

function snapshot(active: unknown, activeAccountId: string | null = 'a') {
  return decodeAccountsSnapshot({
    claude: {
      accounts: [
        { id: 'a', email: 'a@example.com' },
        { id: 'b', email: 'b@example.com' }
      ],
      activeAccountId
    },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: active,
      codex: null,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  })
}

const sessionOf = (cards: ReturnType<typeof selectHomeUsageCards>, accountId: string | null) =>
  cards.find((card) => card.accountId === accountId)?.limits?.session?.usedPercent ?? null

describe('selectHomeUsageCards', () => {
  it("never shows another account's reading on the selected account's card", () => {
    // The desktop still marks a selected, but its last fetch read b.
    const cards = selectHomeUsageCards(
      snapshot(claudeReading(60, { accountId: 'b', runtime: 'host', wslDistro: null })),
      'claude'
    )

    expect(sessionOf(cards, 'a')).toBeNull()
    expect(sessionOf(cards, 'b')).toBe(60)
  })

  it('shows System default usage only from a reading that names System default', () => {
    const stamped = selectHomeUsageCards(
      snapshot(claudeReading(20, { accountId: null, runtime: 'host', wslDistro: null }), null),
      'claude'
    )
    const unstamped = selectHomeUsageCards(snapshot(claudeReading(20), null), 'claude')

    expect(sessionOf(stamped, null)).toBe(20)
    expect(sessionOf(unstamped, null)).toBeNull()
  })

  it('keeps a snapshot with a malformed account stamp, attributing nothing', () => {
    const cards = selectHomeUsageCards(
      snapshot(claudeReading(60, { accountId: 'a', runtime: 'moon' })),
      'claude'
    )

    expect(sessionOf(cards, 'a')).toBeNull()
  })
})
