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
  it("never shows another account's reading on the selected account's card", () => {
    // The desktop still marks a selected, but its last fetch read b.
    const cards = selectHomeUsageCards(
      snapshot(claudeReading(60, { accountId: 'b', runtime: 'wsl', wslDistro: 'Ubuntu' })),
      'claude'
    )

    expect(sessionOf(cards, 'a')).toBeNull()
    expect(sessionOf(cards, 'b')).toBe(60)
  })

  it("shows a WSL account's own reading while the desktop shows host usage", () => {
    const cards = selectHomeUsageCards(
      snapshot(claudeReading(10, { accountId: 'a', runtime: 'host', wslDistro: null }), 'a', {
        inactive: [
          {
            accountId: 'b',
            rateLimits: claudeReading(70, { accountId: 'b', runtime: 'wsl', wslDistro: 'Ubuntu' }),
            updatedAt: 1,
            isFetching: false
          }
        ]
      }),
      'claude'
    )

    expect(sessionOf(cards, 'a')).toBe(10)
    expect(sessionOf(cards, 'b')).toBe(70)
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

  it("shows an older host's usage on System default only while it has no saved accounts", () => {
    const cards = selectHomeUsageCards(
      snapshot(claudeReading(20), null, { accounts: [] }),
      'claude'
    )

    expect(sessionOf(cards, null)).toBe(20)
  })

  it('keeps a snapshot with a malformed account stamp, attributing nothing', () => {
    const cards = selectHomeUsageCards(
      snapshot(claudeReading(60, { accountId: 'a', runtime: 'moon' })),
      'claude'
    )

    expect(sessionOf(cards, 'a')).toBeNull()
  })
})
