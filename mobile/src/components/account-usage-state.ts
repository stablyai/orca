// Keep shapes aligned with shared types/rate-limit-types without pulling Electron-coupled desktop graph into mobile.
// Pure RN-free selectors stay directly testable; AccountUsage re-exports them with UsageBar.
import { formatResetCountdown } from '../../../src/shared/rate-limit-reset-format'
import { hasUsageData } from '../../../src/shared/usage-provider-windows'
import {
  ProviderRateLimitsSchema,
  type AccountsSnapshot,
  type InactiveAccountUsage,
  type ProviderRateLimits,
  type RateLimitWindow
} from './accounts-snapshot'

export {
  AccountsSnapshotSchema,
  decodeAccountsSnapshot,
  ProviderRateLimitsSchema,
  RateLimitRuntimeTargetSchema,
  type AccountProviderRateLimits,
  type AccountsSnapshot,
  type ClaudeAccountSummary,
  type CodexAccountSummary,
  type InactiveAccountUsage,
  type ProviderRateLimits,
  type RateLimitRuntimeTarget,
  type RateLimitWindow
} from './accounts-snapshot'

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
