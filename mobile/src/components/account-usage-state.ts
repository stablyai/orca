// Why: keep these shapes in lockstep with src/shared/types.ts and
// src/shared/rate-limit-types.ts. We don't import from desktop here because
// the mobile bundle must not pull in Electron-coupled type files.
//
// Pure state/selectors live here (no React Native imports) so they can be
// unit-tested directly; AccountUsage.tsx re-exports them alongside the
// UsageBar component.
export type RateLimitWindow = {
  usedPercent: number
  windowMinutes: number
  resetsAt: number | null
  resetDescription: string | null
}

export type ProviderRateLimits = {
  provider: 'claude' | 'codex' | 'gemini' | 'opencode-go' | 'kimi'
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  monthly?: RateLimitWindow | null
  buckets?: Array<RateLimitWindow & { name: string }>
  updatedAt: number
  error: string | null
  status: 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable'
}

export type InactiveAccountUsage = {
  accountId: string
  rateLimits: ProviderRateLimits | null
  updatedAt: number
  isFetching: boolean
}

export type ClaudeAccountSummary = {
  id: string
  email: string
  organizationName?: string | null
}

export type CodexAccountSummary = {
  id: string
  email: string
  workspaceLabel?: string | null
}

export type AccountsSnapshot = {
  claude: { accounts: ClaudeAccountSummary[]; activeAccountId: string | null }
  codex: { accounts: CodexAccountSummary[]; activeAccountId: string | null }
  rateLimits: {
    claude: ProviderRateLimits | null
    codex: ProviderRateLimits | null
    inactiveClaudeAccounts: InactiveAccountUsage[]
    inactiveCodexAccounts: InactiveAccountUsage[]
  }
}

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

// Why: rate limits are fetched for the active target even when no Orca-managed
// account exists (the default target is the agent's own system-default login).
// Treat a provider as having usage worth showing when a fetch succeeded or any
// window has data; an unavailable/error provider with no windows means the
// system-default login has no credentials for it, so there is nothing to show.
export function hasActiveProviderUsage(limits: ProviderRateLimits | null): boolean {
  if (!limits) {
    return false
  }
  if (
    limits.session != null ||
    limits.weekly != null ||
    limits.monthly != null ||
    (limits.buckets && limits.buckets.length > 0)
  ) {
    return true
  }
  return limits.status === 'ok'
}

// Why: transient errors keep the last successful window data, so availability
// is per window rather than per provider status.
export function getUsageBarState(
  limits: ProviderRateLimits | null,
  windowKey: 'session' | 'weekly',
  isFetchingOverride?: boolean
): UsageBarState {
  const window = limits?.[windowKey] ?? null
  const fetching =
    isFetchingOverride ?? (limits?.status === 'fetching' || limits?.status === 'idle')
  return {
    usedPercent: window?.usedPercent ?? null,
    unavailable: window == null && !fetching,
    loading: fetching && window == null
  }
}

/**
 * Why: mirrors desktop status-bar tooltip.tsx duration formatting so the
 * countdown copy matches across surfaces ("3h 54m", "6d 7h"). Duplicated
 * because the mobile bundle must not import renderer code.
 */
function formatResetPhrase(ms: number): string {
  if (ms <= 0) {
    return 'now'
  }
  const totalMins = Math.floor(ms / 60_000)
  if (totalMins < 60) {
    return `in ${totalMins}m`
  }
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `in ${days}d ${remHours}h` : `in ${days}d`
  }
  return mins > 0 ? `in ${hours}h ${mins}m` : `in ${hours}h`
}

/**
 * Builds the reset countdown line shown under the usage bars, e.g.
 * "5h resets in 3h 54m · 7d resets in 6d 7h", or null when no window
 * has a reset timestamp.
 *
 * Why: reuses the bar labels ("5h"/"7d") instead of desktop's
 * "Session"/"Weekly" headings so the line reads against the bars above it.
 * `now` is a parameter so the function stays pure and unit-testable.
 */
export function getResetSummary(limits: ProviderRateLimits | null, now: number): string | null {
  const parts: string[] = []
  const sessionResetsAt = limits?.session?.resetsAt
  if (sessionResetsAt != null) {
    parts.push(`5h resets ${formatResetPhrase(sessionResetsAt - now)}`)
  }
  const weeklyResetsAt = limits?.weekly?.resetsAt
  if (weeklyResetsAt != null) {
    parts.push(`7d resets ${formatResetPhrase(weeklyResetsAt - now)}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

// Why: the usage UI must render for the system-default login, not only for
// Orca-managed accounts. Show a provider when it has at least one managed
// account OR active rate-limit data for the system-default target.
export function hasRenderableUsage(snapshot: AccountsSnapshot, provider: ProviderKey): boolean {
  const accounts = provider === 'claude' ? snapshot.claude.accounts : snapshot.codex.accounts
  if (accounts.length > 0) {
    return true
  }
  return hasActiveProviderUsage(getActiveProviderRateLimits(snapshot, provider))
}
