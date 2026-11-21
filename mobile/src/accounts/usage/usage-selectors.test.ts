import { describe, expect, it } from 'vitest'
import {
  decodeAccountsSnapshot,
  type AccountsSnapshot,
  type ProviderRateLimits
} from '../accounts-snapshot'
import { getSystemDefaultProviderUsage } from './usage-selectors'

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

function snapshot(activeAccountId: string | null): AccountsSnapshot {
  return decodeAccountsSnapshot({
    claude: { accounts: [], activeAccountId },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: claudeReading(80),
      codex: null,
      inactiveClaudeAccounts: [
        {
          accountId: 'claude-system-default',
          rateLimits: claudeReading(37),
          updatedAt: 1,
          isFetching: false
        }
      ],
      inactiveCodexAccounts: []
    }
  })
}

describe('getSystemDefaultProviderUsage', () => {
  it("shows the host's System default reading while a saved Claude account is selected", () => {
    expect(getSystemDefaultProviderUsage(snapshot('saved'), 'claude', 'saved')?.session).toEqual(
      expect.objectContaining({ usedPercent: 37 })
    )
  })

  it('shows the live reading while System default is selected', () => {
    expect(getSystemDefaultProviderUsage(snapshot(null), 'claude', null)?.session).toEqual(
      expect.objectContaining({ usedPercent: 80 })
    )
  })
})
