import {
  getActiveProviderRateLimits,
  getInactiveProviderUsage,
  hasActiveProviderUsage,
  hasRenderableUsage,
  type ProviderKey
} from '../../accounts/usage/usage-selectors'
import type { AccountsSnapshot, ProviderRateLimits } from '../../accounts/accounts-snapshot'
import { getActiveCodexAccountIdForRateLimitTarget } from '../../accounts/usage/codex-reset-credit'

export type HomeUsageCard = {
  /** The managed account's id, or null for the agent's own login (System default). */
  accountId: string | null
  email: string | null
  displayName?: string
  /** Claude's organization or Codex's workspace, when the desktop knows it. */
  subtitle: string | null
  active: boolean
  limits: ProviderRateLimits | null
  fetching: boolean
  /** System default shows meters only once its login has reported quota. */
  metered: boolean
}

export type HomeUsageSection = {
  provider: ProviderKey
  /** When the active login's usage was last fetched; null before the first fetch. */
  updatedAt: number | null
  cards: HomeUsageCard[]
}

const PROVIDERS: readonly ProviderKey[] = ['claude', 'codex']

// Codex picks its active account per runtime target, so read it the way the Accounts screen does.
function activeAccountId(snapshot: AccountsSnapshot, provider: ProviderKey): string | null {
  if (provider === 'codex' && snapshot.codex.activeAccountIdsByRuntime) {
    return getActiveCodexAccountIdForRateLimitTarget(snapshot)
  }
  return snapshot[provider].activeAccountId
}

function managedAccounts(snapshot: AccountsSnapshot, provider: ProviderKey) {
  return provider === 'claude'
    ? snapshot.claude.accounts.map((account) => ({
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        subtitle: account.organizationName ?? null
      }))
    : snapshot.codex.accounts.map((account) => ({
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        subtitle: account.workspaceLabel ?? null
      }))
}

/** One card per login on the provider: System default only while no managed account is active, then active first. */
export function selectHomeUsageCards(
  snapshot: AccountsSnapshot,
  provider: ProviderKey
): HomeUsageCard[] {
  const activeId = activeAccountId(snapshot, provider)
  const activeLimits = getActiveProviderRateLimits(snapshot, provider)
  const cards: HomeUsageCard[] = []
  if (activeId === null) {
    cards.push({
      accountId: null,
      email: null,
      subtitle: null,
      active: true,
      limits: activeLimits,
      fetching: activeLimits?.status === 'fetching',
      metered: hasActiveProviderUsage(activeLimits)
    })
  }
  for (const account of managedAccounts(snapshot, provider)) {
    const active = account.id === activeId
    const inactive = active ? null : getInactiveProviderUsage(snapshot, provider, account.id)
    const limits = active ? activeLimits : (inactive?.rateLimits ?? null)
    cards.push({
      accountId: account.id,
      email: account.email,
      displayName: account.displayName,
      subtitle: account.subtitle,
      active,
      limits,
      fetching: active ? limits?.status === 'fetching' : inactive?.isFetching === true,
      metered: true
    })
  }
  return cards.sort((left, right) => Number(right.active) - Number(left.active))
}

/** The providers with usage to show on one desktop, Claude before Codex. */
export function selectHomeUsageSections(snapshot: AccountsSnapshot): HomeUsageSection[] {
  return PROVIDERS.filter((provider) => hasRenderableUsage(snapshot, provider)).map((provider) => {
    const updatedAt = getActiveProviderRateLimits(snapshot, provider)?.updatedAt ?? 0
    return {
      provider,
      updatedAt: updatedAt > 0 ? updatedAt : null,
      cards: selectHomeUsageCards(snapshot, provider)
    }
  })
}
