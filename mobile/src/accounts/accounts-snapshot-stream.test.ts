import { expect, it } from 'vitest'
import { decodeAccountsSnapshot } from './accounts-snapshot'
import { accountsSnapshotFamily, withoutAccountUsage } from './accounts-snapshot-stream'

it('keeps plugin quota readings out of offline account snapshots', () => {
  const accounts = { accounts: [], activeAccountId: null }
  const snapshot = decodeAccountsSnapshot({
    claude: accounts,
    codex: accounts,
    rateLimits: {
      claude: null,
      codex: {
        provider: 'codex',
        status: 'ok',
        session: { windowMinutes: 300, usedPercent: 25, resetsAt: null, resetDescription: null },
        weekly: null,
        updatedAt: 1,
        error: null
      },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    },
    pluginUsageProviders: [
      {
        pluginKey: 'local.example',
        providerId: 'gateway',
        label: 'Sample quota',
        windows: [{ windowMinutes: 300, usedPercent: 28, resetsAt: null }],
        observedAt: 1
      }
    ]
  })

  const offline = withoutAccountUsage(snapshot)
  const persisted = accountsSnapshotFamily.persist.strip?.(snapshot)
  expect(offline).toEqual(persisted)
  expect(offline?.rateLimits.codex).toBeNull()
  expect(offline).not.toHaveProperty('pluginUsageProviders')
  expect(offline?.codex).toEqual(accounts)
  expect(snapshot.pluginUsageProviders).toHaveLength(1)
})
