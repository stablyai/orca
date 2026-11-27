import { describe, expect, it } from 'vitest'
import { AccountsSnapshotSchema } from '../accounts-snapshot'
import { getSystemDefaultProviderUsage } from './usage-selectors'

function snapshot(codexTarget: { runtime: 'host' | 'wsl'; wslDistro: string | null }) {
  return AccountsSnapshotSchema.parse({
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: 'work' },
    rateLimits: {
      claude: null,
      codex: null,
      codexTarget,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [
        {
          accountId: 'codex-system-default',
          rateLimits: {
            provider: 'codex',
            session: {
              usedPercent: 12,
              windowMinutes: 300,
              resetsAt: null,
              resetDescription: null
            },
            weekly: null,
            updatedAt: 1,
            error: null,
            status: 'ok'
          },
          updatedAt: 1,
          isFetching: false
        }
      ]
    }
  })
}

describe('getSystemDefaultProviderUsage', () => {
  it('shows the host System default reading only on a host Codex target', () => {
    const host = getSystemDefaultProviderUsage(
      snapshot({ runtime: 'host', wslDistro: null }),
      'codex',
      'work'
    )
    const wsl = getSystemDefaultProviderUsage(
      snapshot({ runtime: 'wsl', wslDistro: 'Ubuntu' }),
      'codex',
      'work'
    )
    expect(host.limits?.session?.usedPercent).toBe(12)
    expect(wsl.limits).toBeNull()
  })
})
