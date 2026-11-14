import type { BackendConnectionPurpose, UsageAction } from '../../shared/backend-service-contract'
import type { UsageHistoryProvider } from '../../shared/usage-history-types'
import type { UsageHistorySnapshot, UsageSnapshotQuery } from '../../shared/usage-history-rpc'

type UsageHistoryInvoker = (
  method: string,
  params: unknown,
  purpose?: BackendConnectionPurpose
) => Promise<unknown>

const PROVIDER_PREFIX = {
  claude: 'claudeUsage',
  codex: 'codexUsage',
  opencode: 'openCodeUsage',
  muse: 'museUsage'
} as const

export class UsageProviderFacade {
  private invoke: UsageHistoryInvoker | null = null

  setInvoker(invoke: UsageHistoryInvoker): void {
    this.invoke = invoke
  }

  async getSnapshot(
    provider: UsageHistoryProvider,
    query: UsageSnapshotQuery
  ): Promise<UsageHistorySnapshot> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The bundled usage service constructs this provider's typed snapshot; only its private transport erases the return type.
    return (await this.call(provider, 'getSnapshot', query, 'recovery')) as UsageHistorySnapshot
  }

  refresh(provider: UsageHistoryProvider, force = false): Promise<unknown> {
    return this.call(provider, 'refresh', { force })
  }

  setEnabled(provider: UsageHistoryProvider, enabled: boolean): Promise<unknown> {
    return this.call(provider, 'setEnabled', { enabled })
  }

  private call(
    provider: UsageHistoryProvider,
    action: UsageAction,
    params: unknown,
    purpose?: BackendConnectionPurpose
  ): Promise<unknown> {
    if (!this.invoke) {
      return Promise.reject(new Error('Historical usage is not configured on this runtime'))
    }
    return this.invoke(`${PROVIDER_PREFIX[provider]}:${action}`, params, purpose)
  }
}
