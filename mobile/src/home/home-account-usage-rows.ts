import {
  getActiveProviderRateLimits,
  hasRenderableUsage,
  type AccountsSnapshot,
  type ProviderKey,
  type ProviderRateLimits
} from '../components/account-usage-state'
import type { HostProfile } from '../transport/types'

export type HomeAccountUsageRow = {
  host: HostProfile
  provider: ProviderKey
  /** The active account's email; null means the agent's own login (System default). */
  email: string | null
  limits: ProviderRateLimits | null
}

const PROVIDERS: readonly ProviderKey[] = ['claude', 'codex']

/** One row per provider with usage on each connected desktop, in the desktops' order. */
export function selectHomeAccountUsageRows(
  connectedHosts: readonly HostProfile[],
  accountsByHost: Record<string, AccountsSnapshot>
): HomeAccountUsageRow[] {
  const rows: HomeAccountUsageRow[] = []
  for (const host of connectedHosts) {
    const snapshot = accountsByHost[host.id]
    if (!snapshot) {
      continue
    }
    for (const provider of PROVIDERS) {
      if (!hasRenderableUsage(snapshot, provider)) {
        continue
      }
      const { activeAccountId } = snapshot[provider]
      const accounts: readonly { id: string; email: string }[] = snapshot[provider].accounts
      rows.push({
        host,
        provider,
        email: accounts.find((account) => account.id === activeAccountId)?.email ?? null,
        limits: getActiveProviderRateLimits(snapshot, provider)
      })
    }
  }
  return rows
}
