// Keep shapes aligned with shared types/rate-limit-types without pulling Electron-coupled desktop graph into mobile.
// Pure RN-free selectors stay directly testable; AccountUsage re-exports them with UsageBar.
import { formatResetCountdown } from '../../../src/shared/rate-limit-reset-format'
import type {
  AccountsSnapshot,
  InactiveAccountUsage,
  ProviderRateLimits
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
    limits.fableWeekly != null ||
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

// Use desktop formatResetCountdown copy with injectable now; return null without reset timestamp to retain bars-only UI.
export function getWindowResetLabel(
  limits: ProviderRateLimits | null,
  windowKey: 'session' | 'weekly',
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

export type AdditionalUsageProviderKey =
  | 'antigravity'
  | 'gemini'
  | 'cursor'
  | 'grok'
  | 'opencodeGo'
  | 'kimi'
  | 'minimax'
  | 'zcode'

const ADDITIONAL_USAGE_PROVIDERS = [
  'antigravity',
  'gemini',
  'cursor',
  'grok',
  'opencodeGo',
  'kimi',
  'minimax',
  'zcode'
] as const

export type AdditionalProviderUsageBar = {
  label: string
  usedPercent: number
  unavailable: false
  loading: false
  resetText: string | null
}

export type AdditionalProviderUsageRow = {
  title: string
  bars: AdditionalProviderUsageBar[]
}

export type ActiveAdditionalProvider = {
  key: AdditionalUsageProviderKey
  limits: ProviderRateLimits
}

type UsageBucket = NonNullable<ProviderRateLimits['buckets']>[number]

export function getActiveAdditionalProviders(
  snapshot: AccountsSnapshot
): ActiveAdditionalProvider[] {
  const active: ActiveAdditionalProvider[] = []
  for (const key of ADDITIONAL_USAGE_PROVIDERS) {
    const limits = snapshot.rateLimits[key]
    if (!limits || limits.status === 'unavailable') {
      continue
    }
    if (!hasActiveProviderUsage(limits) && limits.status !== 'error') {
      continue
    }
    active.push({ key, limits })
  }
  return active
}

function barFor(
  label: string,
  window: { usedPercent: number; resetsAt: number | null },
  now: number
): AdditionalProviderUsageBar {
  return {
    label,
    usedPercent: window.usedPercent,
    unavailable: false,
    loading: false,
    resetText: window.resetsAt == null ? null : formatResetCountdown(window.resetsAt - now)
  }
}

function shortWindowLabel(windowMinutes: number, windowName?: string): string {
  if (windowMinutes === 300) {
    return '5h'
  }
  if (windowMinutes === 1440) {
    return '24h'
  }
  if (windowMinutes === 10080) {
    return '7d'
  }
  if (windowMinutes >= 40000) {
    return '30d'
  }
  if (windowMinutes === 60) {
    return '1h'
  }
  if (windowMinutes > 0 && windowMinutes % 1440 === 0) {
    return `${windowMinutes / 1440}d`
  }
  if (windowMinutes > 0 && windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`
  }
  if (windowMinutes > 0) {
    return `${windowMinutes}m`
  }
  const named = windowName?.replace(/\s*limit remaining$/i, '').trim()
  return named && named.length > 0 ? named : '—'
}

function bucketGroup(bucket: UsageBucket): string | null {
  return typeof bucket.group === 'string' && bucket.group.length > 0 ? bucket.group : null
}

function groupedUsageRows(buckets: UsageBucket[], now: number): AdditionalProviderUsageRow[] {
  const groups = new Map<string, UsageBucket[]>()
  for (const bucket of buckets) {
    const group = bucketGroup(bucket) ?? bucket.name
    const list = groups.get(group) ?? []
    list.push(bucket)
    groups.set(group, list)
  }
  return [...groups.entries()].map(([title, groupBuckets]) => ({
    title,
    bars: [...groupBuckets]
      .sort((left, right) => left.windowMinutes - right.windowMinutes)
      .map((bucket) =>
        barFor(shortWindowLabel(bucket.windowMinutes, bucket.windowName), bucket, now)
      )
  }))
}

// Why: Cursor's monthly allowance is the plan meter once membership is known.
function planRowTitle(limits: ProviderRateLimits): string {
  const plan = limits.planType?.trim()
  return plan ? 'Plan' : 'Monthly'
}

function ungroupedBucketRows(
  limits: ProviderRateLimits,
  buckets: UsageBucket[],
  now: number
): AdditionalProviderUsageRow[] {
  const rows: AdditionalProviderUsageRow[] = []
  if (limits.monthly) {
    rows.push({ title: planRowTitle(limits), bars: [barFor('30d', limits.monthly, now)] })
  }
  for (const bucket of buckets) {
    rows.push({
      title: bucket.name,
      bars: [barFor(shortWindowLabel(bucket.windowMinutes, bucket.windowName), bucket, now)]
    })
  }
  return rows
}

function usageIdentityTitle(limits: ProviderRateLimits): string {
  const provenance = limits.usageMetadata?.authProvenance
  if (provenance && provenance.includes('@')) {
    return provenance
  }
  return 'System default'
}

function standardWindowRows(limits: ProviderRateLimits, now: number): AdditionalProviderUsageRow[] {
  const bars: AdditionalProviderUsageBar[] = []
  if (limits.session) {
    bars.push(barFor('5h', limits.session, now))
  }
  if (limits.weekly) {
    bars.push(barFor('7d', limits.weekly, now))
  }
  if (limits.fableWeekly) {
    bars.push(barFor('Fable', limits.fableWeekly, now))
  }
  if (limits.monthly) {
    // Why: Z.ai reports its MCP quota on the monthly window; other plans are a 30-day meter.
    bars.push(barFor(limits.provider === 'zcode' ? 'MCP' : '30d', limits.monthly, now))
  }
  return [{ title: usageIdentityTitle(limits), bars }]
}

// Why: Antigravity groups pools, Cursor/Gemini name each bucket, and the rest use fixed windows.
export function getAdditionalProviderUsageRows(
  limits: ProviderRateLimits,
  now: number
): AdditionalProviderUsageRow[] {
  const buckets = limits.buckets ?? []
  if (buckets.some((bucket) => bucketGroup(bucket) != null)) {
    return groupedUsageRows(buckets, now)
  }
  if (buckets.length > 0) {
    return ungroupedBucketRows(limits, buckets, now)
  }
  return standardWindowRows(limits, now)
}

export function hasAnyRenderableUsage(snapshot: AccountsSnapshot): boolean {
  return (
    hasRenderableUsage(snapshot, 'claude') ||
    hasRenderableUsage(snapshot, 'codex') ||
    getActiveAdditionalProviders(snapshot).length > 0
  )
}
