import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { AccountsSnapshot } from '../../../components/accounts-snapshot'

const ACCOUNT_REVISION = 1_700_000_000_000

// Derive request scope from this offer through product code instead of inventing expected wire params.
const CODEX_ACCOUNTS = mountFixture<AccountsSnapshot>({
  claude: { accounts: [], activeAccountId: null },
  codex: {
    accounts: [{ id: 'codex-1', email: 'codex@example.test', updatedAt: ACCOUNT_REVISION }],
    activeAccountId: 'codex-1',
    activeAccountIdsByRuntime: { host: 'codex-1', wsl: {} }
  },
  rateLimits: {
    claude: null,
    codex: {
      provider: 'codex',
      session: null,
      weekly: null,
      rateLimitResetCredits: { availableCount: 1 },
      updatedAt: ACCOUNT_REVISION,
      error: null,
      status: 'ok'
    },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
})

export function codexResetCreditMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'accounts.codex-reset-credit': ({ client }) => {
      const credit = modules.load<typeof import('../../../components/codex-reset-credit')>(
        'mobile/src/components/codex-reset-credit.ts'
      )
      const snapshot = modules
        .load<typeof import('../../../components/accounts-snapshot')>(
          'mobile/src/components/accounts-snapshot.ts'
        )
        .decodeAccountsSnapshot(CODEX_ACCOUNTS)
      let settled: unknown = null
      return {
        action(name) {
          if (name !== 'confirm') {
            throw new Error(`Unknown reset credit action: ${name}`)
          }
          const expectedScope = credit.getCodexResetCreditScope(snapshot)
          if (!expectedScope) {
            throw new Error('The recorded snapshot offers no reset credit to confirm')
          }
          const pending = credit.requestCodexResetCredit(client, expectedScope)
          void pending.then(
            (result) => {
              settled = { outcome: 'outcome' in result ? result.outcome : result.status }
            },
            () => undefined
          )
          return pending
        },
        state: () => ({ settled }),
        dispose: () => {}
      }
    }
  }
}
