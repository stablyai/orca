// Keep shapes aligned with shared types/rate-limit-types without pulling Electron-coupled desktop graph into mobile.
import { formatResetCountdown } from '../../../../src/shared/agent-usage/rate-limits/rate-limit-reset-format'
import { hasUsageData } from '../../../../src/shared/agent-usage/display/usage-provider-windows'
import { CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID } from '../../../../src/shared/agent-accounts/claude/claude-system-default-usage'
import {
  getObservedAccountUsage,
  indexAccountUsageObservations
} from '../../../../src/shared/agent-usage/rate-limits/account-usage-observations'
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

type UsageAccount = {
  id: string
  managedAuthRuntime?: 'host' | 'wsl'
  managedHomeRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
}

type AccountUsageReadings = (account: UsageAccount | null) => ProviderRateLimits | null

/** Each account's usage from the readings that name it, never from which account is selected:
 *  the selection can change while a fetch is in flight. `account` null is System default. */
export function getAccountUsageReadings(
  snapshot: AccountsSnapshot,
  provider: ProviderKey
): AccountUsageReadings {
  const active = getActiveProviderRateLimits(snapshot, provider)
  const observations = indexAccountUsageObservations(
    active,
    provider === 'claude'
      ? snapshot.rateLimits.inactiveClaudeAccounts
      : snapshot.rateLimits.inactiveCodexAccounts
  )
  const target =
    provider === 'claude' ? snapshot.rateLimits.claudeTarget : snapshot.rateLimits.codexTarget
  const activeSlot =
    active?.usageMetadata?.readingAccount ?? active?.usageMetadata?.attemptedAccount
  // An unnamed WSL target reads the default distro, which its own reading names.
  const targetDistro =
    target.runtime === 'wsl' ? (target.wslDistro ?? activeSlot?.wslDistro ?? null) : null
  // A host that predates the stamp reads only System default while it has no saved accounts.
  const unstampedSystemDefault =
    !activeSlot && snapshot[provider].accounts.length === 0 ? active : null
  return (account) =>
    account
      ? // Saved accounts are read in their own runtime's login, whichever target is shown.
        getObservedAccountUsage(observations, {
          accountId: account.id,
          runtime: account.managedHomeRuntime ?? account.managedAuthRuntime ?? 'host',
          wslDistro: account.wslDistro ?? null
        })
      : (unstampedSystemDefault ??
        getObservedAccountUsage(observations, {
          accountId: null,
          runtime: target.runtime,
          wslDistro: targetDistro
        }))
}

/** System default's reading from the slot it names; the loading flag is the live one while it is
 *  selected, else the one the host sets on its reserved entry (Claude). */
export function getSystemDefaultProviderUsage(
  snapshot: AccountsSnapshot,
  provider: ProviderKey,
  activeAccountId: string | null,
  readingFor: AccountUsageReadings
): { limits: ProviderRateLimits | null; isFetching: boolean } {
  const limits = readingFor(null)
  if (activeAccountId === null) {
    const fetching = getActiveProviderRateLimits(snapshot, provider)?.status === 'fetching'
    return { limits, isFetching: fetching }
  }
  // A host re-reading an unselected login flags the entry, not the reading's status.
  const entry =
    provider === 'claude'
      ? getInactiveProviderUsage(snapshot, provider, CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID)
      : null
  return { limits, isFetching: entry?.isFetching === true }
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
