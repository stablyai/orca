// Keep shapes aligned with shared types/rate-limit-types without pulling Electron-coupled desktop graph into mobile.
// Pure RN-free selectors stay directly testable; AccountUsage re-exports them with UsageBar.
import { isCursorUsageBucket } from '../../../src/shared/cursor-usage-buckets'
import { formatResetCountdown } from '../../../src/shared/rate-limit-reset-format'
import type {
  AccountsSnapshot,
  InactiveAccountUsage,
  ProviderRateLimits,
  RateLimitWindow
} from './accounts-snapshot'

export {
  AccountsSnapshotSchema,
  decodeAccountsSnapshot,
  ProviderRateLimitsSchema,
  RateLimitRuntimeTargetSchema,
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

export type UsageWindowKey = 'session' | 'weekly' | 'monthly'

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

// Determine availability per window because transient provider errors retain successful window data.
export function getUsageBarState(
  limits: ProviderRateLimits | null,
  windowKey: UsageWindowKey,
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

// Use desktop formatResetCountdown copy with injectable now; return null without reset timestamp to retain bars-only UI.
export function getWindowResetLabel(
  limits: ProviderRateLimits | null,
  windowKey: UsageWindowKey,
  now: number
): string | null {
  const resetsAt = limits?.[windowKey]?.resetsAt
  if (resetsAt == null) {
    return null
  }
  return formatResetCountdown(resetsAt - now)
}

// Show provider with managed accounts or active system-default quota; management is not required for usage UI.
export function hasRenderableUsage(snapshot: AccountsSnapshot, provider: ProviderKey): boolean {
  const accounts = provider === 'claude' ? snapshot.claude.accounts : snapshot.codex.accounts
  if (accounts.length > 0) {
    return true
  }
  return hasActiveProviderUsage(getActiveProviderRateLimits(snapshot, provider))
}

// Weekly credits are the Grok CLI default. Monthly is only the unified-billing window.
export function getGrokUsageWindowKey(limits: ProviderRateLimits | null): 'weekly' | 'monthly' {
  return limits?.monthly && !limits.weekly ? 'monthly' : 'weekly'
}

export function readUsageAuthProvenance(limits: ProviderRateLimits | null): string | null {
  const metadata = limits?.usageMetadata
  if (typeof metadata !== 'object' || metadata === null || !('authProvenance' in metadata)) {
    return null
  }
  const provenance = metadata.authProvenance
  return typeof provenance === 'string' && provenance.trim() !== '' ? provenance : null
}

export const MOBILE_USAGE_PROVIDER_IDS = [
  'gemini',
  'opencodeGo',
  'antigravity',
  'minimax',
  'grok',
  'cursor',
  'zcode'
] as const

export type MobileUsageProviderId = (typeof MOBILE_USAGE_PROVIDER_IDS)[number]

export type UsageMeter = {
  key: string
  chip: string
  title: string | null
  usedPercent: number | null
  unavailable: boolean
  loading: boolean
  resetsAt: number | null
  resetDescription: string | null
}

const GEMINI_USAGE_BUCKETS = new Set(['Flash', 'Pro', '1.5 Pro'])

export function hasRenderableGrokUsage(snapshot: AccountsSnapshot): boolean {
  return hasRenderableProviderUsage(snapshot, 'grok')
}

export function hasRenderableProviderUsage(
  snapshot: AccountsSnapshot,
  provider: MobileUsageProviderId
): boolean {
  if (providerAuthConfigured(snapshot, provider)) {
    return true
  }
  const limits = snapshot.rateLimits[provider] ?? null
  if (!limits) {
    return false
  }
  if (limits.status === 'fetching' || limits.status === 'error') {
    return true
  }
  return collectProviderUsageMeters(provider, limits).length > 0
}

export function collectProviderUsageMeters(
  provider: MobileUsageProviderId,
  limits: ProviderRateLimits | null
): UsageMeter[] {
  if (!limits) {
    return []
  }
  if (provider === 'grok') {
    const windowKey = getGrokUsageWindowKey(limits)
    const window = limits[windowKey]
    return window ? [meterFromWindow(windowKey, window, null)] : []
  }
  if (provider === 'zcode') {
    return zcodeMeters(limits)
  }
  if (limits.buckets && limits.buckets.length > 0) {
    const buckets = usageBuckets(limits)
    if (buckets.length > 0) {
      const meters = buckets.map((bucket) => meterFromWindow(bucket.name, bucket, bucket.name))
      if (provider === 'cursor' && limits.monthly) {
        meters.push(meterFromWindow('plan', limits.monthly, 'Plan'))
      }
      return meters
    }
    const fallback = limits.session ?? limits.monthly ?? limits.weekly
    return fallback ? [meterFromWindow('fallback', fallback, null)] : []
  }
  return standardWindows(limits)
}

// Auth is configured, or the payload has no drawable window yet. Keep one bar so the section is not blank.
export function providerUsagePlaceholder(
  provider: MobileUsageProviderId,
  limits: ProviderRateLimits | null
): UsageMeter {
  const loading = limits == null || limits.status === 'fetching' || limits.status === 'idle'
  return {
    key: 'usage',
    chip: provider === 'grok' ? (getGrokUsageWindowKey(limits) === 'monthly' ? 'mo' : 'wk') : '',
    title: null,
    usedPercent: null,
    unavailable: !loading,
    loading,
    resetsAt: null,
    resetDescription: null
  }
}

export function getMeterResetLabel(meter: UsageMeter, now: number): string | null {
  if (meter.resetsAt != null) {
    return formatResetCountdown(meter.resetsAt - now)
  }
  const description = meter.resetDescription?.trim()
  return description ? description : null
}

function providerAuthConfigured(
  snapshot: AccountsSnapshot,
  provider: MobileUsageProviderId
): boolean {
  const limits = snapshot.rateLimits
  switch (provider) {
    case 'opencodeGo':
      return limits.opencodeGoApiKeyConfigured === true
    case 'minimax':
      return limits.minimaxCookieConfigured === true || limits.minimaxApiKeyConfigured === true
    case 'grok':
      return limits.grokAuthConfigured === true
    case 'cursor':
      return limits.cursorAuthConfigured === true
    case 'zcode':
      return limits.zcodePlanApiKeyConfigured === true
    case 'gemini':
    case 'antigravity':
      return false
  }
}

function usageBuckets(limits: ProviderRateLimits): Array<RateLimitWindow & { name: string }> {
  return (limits.buckets ?? []).filter(
    (bucket) =>
      limits.provider === 'antigravity' ||
      GEMINI_USAGE_BUCKETS.has(bucket.name) ||
      isCursorUsageBucket(bucket.name)
  )
}

function standardWindows(limits: ProviderRateLimits): UsageMeter[] {
  const meters: UsageMeter[] = []
  if (limits.session) {
    meters.push(meterFromWindow('session', limits.session, null))
  }
  if (limits.weekly) {
    meters.push(meterFromWindow('weekly', limits.weekly, null))
  }
  if (limits.fableWeekly) {
    meters.push(meterFromWindow('fableWeekly', limits.fableWeekly, 'Fable'))
  }
  if (limits.monthly && !limits.session && !limits.weekly) {
    meters.push(meterFromWindow('monthly', limits.monthly, null))
  }
  return meters
}

function zcodeMeters(limits: ProviderRateLimits): UsageMeter[] {
  const meters: UsageMeter[] = []
  if (limits.session) {
    meters.push(meterFromWindow('session', limits.session, null))
  }
  if (limits.weekly) {
    meters.push(meterFromWindow('weekly', limits.weekly, null))
  }
  if (limits.monthly) {
    meters.push(meterFromWindow('monthly', limits.monthly, 'MCP monthly'))
  }
  return meters
}

function meterFromWindow(key: string, window: RateLimitWindow, title: string | null): UsageMeter {
  const chip = windowChip(window.windowMinutes)
  const stacked = title != null || chip.length > 3
  return {
    key,
    chip: stacked ? '' : chip,
    title: title ?? (stacked ? chip : null),
    usedPercent: window.usedPercent,
    unavailable: false,
    loading: false,
    resetsAt: window.resetsAt,
    resetDescription: window.resetDescription
  }
}

function windowChip(windowMinutes: number): string {
  if (windowMinutes === 10080) {
    return 'wk'
  }
  if (windowMinutes === 43200) {
    return 'mo'
  }
  if (windowMinutes === 300) {
    return '5h'
  }
  if (windowMinutes === 60) {
    return '1h'
  }
  if (windowMinutes < 60) {
    return `${windowMinutes}m`
  }
  if (windowMinutes % (60 * 24 * 7) === 0) {
    const weeks = windowMinutes / (60 * 24 * 7)
    return weeks === 1 ? 'wk' : `${weeks}wk`
  }
  if (windowMinutes % (60 * 24) === 0) {
    return `${windowMinutes / (60 * 24)}d`
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`
  }
  return `${windowMinutes}m`
}
