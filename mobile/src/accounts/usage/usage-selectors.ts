// Keep shapes aligned with shared types/rate-limit-types without pulling Electron-coupled desktop graph into mobile.
import { formatResetCountdown } from '../../../../src/shared/agent-usage/rate-limits/rate-limit-reset-format'
import { hasUsageData } from '../../../../src/shared/agent-usage/display/usage-provider-windows'
import { hostSystemDefaultUsageId } from '../../../../src/shared/agent-accounts/host-system-default-usage'
import {
  ProviderRateLimitsSchema,
  type AccountsSnapshot,
  type InactiveAccountUsage,
  type ProviderRateLimits,
  type RateLimitWindow
} from '../accounts-snapshot'

export type ProviderKey = 'claude' | 'codex'

export type UsageBarState = {
  usedPercent: number | null
  unavailable: boolean
  loading: boolean
}

export function getActiveProviderRateLimits(
  snapshot: AccountsSnapshot,
  provider: ProviderKey
): ProviderRateLimits | null {
  return provider === 'claude' ? snapshot.rateLimits.claude : snapshot.rateLimits.codex
}

export function getInactiveProviderUsage(
  snapshot: AccountsSnapshot,
  provider: ProviderKey,
  accountId: string
): InactiveAccountUsage | null {
  const list =
    provider === 'claude'
      ? snapshot.rateLimits.inactiveClaudeAccounts
      : snapshot.rateLimits.inactiveCodexAccounts
  return list.find((u) => u.accountId === accountId) ?? null
}

/** System default's reading: live while it is selected, else the one the host keeps under its usage key. */
export function getSystemDefaultProviderUsage(
  snapshot: AccountsSnapshot,
  provider: ProviderKey,
  activeAccountId: string | null
): { limits: ProviderRateLimits | null; isFetching: boolean } {
  if (activeAccountId === null) {
    const limits = getActiveProviderRateLimits(snapshot, provider)
    return { limits, isFetching: limits?.status === 'fetching' }
  }
  // A Codex target in WSL selects that distro's own login, which the host keeps no reading for.
  const usageId = hostSystemDefaultUsageId(
    provider,
    provider === 'codex' ? snapshot.rateLimits.codexTarget : undefined
  )
  // A host re-reading an unselected login flags the entry, not the reading's status.
  const entry = usageId ? getInactiveProviderUsage(snapshot, provider, usageId) : null
  return { limits: entry?.rateLimits ?? null, isFetching: entry?.isFetching === true }
}

// System-default logins still fetch quota without managed accounts. Show successful provider or any window data; empty unavailable/error means no credentials.
export function hasActiveProviderUsage(limits: ProviderRateLimits | null): boolean {
  return limits !== null && (hasUsageData(limits) || limits.status === 'ok')
}

// Determine availability per window because transient provider errors retain successful window data.
export function getUsageBarState(
  limits: ProviderRateLimits | null,
  window: RateLimitWindow | null,
  isFetchingOverride?: boolean
): UsageBarState {
  const fetching =
    isFetchingOverride ?? (limits?.status === 'fetching' || limits?.status === 'idle')
  return {
    usedPercent: window?.usedPercent ?? null,
    unavailable: window == null && !fetching,
    loading: fetching && window == null
  }
}

// Use desktop formatResetCountdown copy with injectable now; return null without reset timestamp to retain bars-only UI.
export function getWindowResetLabel(window: RateLimitWindow | null, now: number): string | null {
  if (window?.resetsAt == null) {
    return null
  }
  return formatResetCountdown(window.resetsAt - now)
}

/** Every other provider the host reports usage for, in the host's order; Claude and Codex have their own sections. */
export function getOtherUsageProviders(snapshot: AccountsSnapshot): ProviderRateLimits[] {
  const providers: ProviderRateLimits[] = []
  for (const [slot, value] of Object.entries(snapshot.rateLimits)) {
    if (slot === 'claude' || slot === 'codex') {
      continue
    }
    const parsed = ProviderRateLimitsSchema.safeParse(value)
    // Hidden or signed-out providers come back idle or unavailable with no windows.
    if (parsed.success && (hasUsageData(parsed.data) || parsed.data.status === 'error')) {
      providers.push(parsed.data)
    }
  }
  return providers
}

// Show provider with managed accounts or active system-default quota; management is not required for usage UI.
export function hasRenderableUsage(snapshot: AccountsSnapshot, provider: ProviderKey): boolean {
  const accounts = provider === 'claude' ? snapshot.claude.accounts : snapshot.codex.accounts
  if (accounts.length > 0) {
    return true
  }
  return hasActiveProviderUsage(getActiveProviderRateLimits(snapshot, provider))
}
