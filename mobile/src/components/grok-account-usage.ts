import {
  ProviderRateLimitsSchema,
  type AccountsSnapshot,
  type ProviderRateLimits
} from './accounts-snapshot'
import {
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  hasRenderableUsage,
  type UsageBarState
} from './account-usage-state'

export type GrokUsageWindowKey = 'weekly' | 'monthly'

export type GrokAccountUsage = {
  limits: ProviderRateLimits | null
  label: string
  windowKey: GrokUsageWindowKey | null
}

export type GrokUsageBarModel = {
  windowLabel: string
  labelWidth: number
  bar: UsageBarState
  resetText: string | null
}

const DEFAULT_LABEL_WIDTH = 22
const MONTHLY_LABEL_WIDTH = 28

function readField(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key]
}

function readGrokAuthConfigured(snapshot: AccountsSnapshot): boolean {
  return readField(snapshot.rateLimits, 'grokAuthConfigured') === true
}

// Why: decode this slot on its own. A malformed Grok payload must not fail the
// Claude/Codex snapshot, and a foreign provider identity must not be shown as Grok.
function readGrokLimits(snapshot: AccountsSnapshot): ProviderRateLimits | null {
  const raw = readField(snapshot.rateLimits, 'grok')
  if (raw == null) {
    return null
  }
  const parsed = ProviderRateLimitsSchema.safeParse(raw)
  if (!parsed.success || parsed.data.provider !== 'grok') {
    return null
  }
  return parsed.data
}

function readAuthProvenance(limits: ProviderRateLimits | null): string | null {
  if (!limits) {
    return null
  }
  const metadata = readField(limits, 'usageMetadata')
  if (!metadata || typeof metadata !== 'object') {
    return null
  }
  const provenance = readField(metadata, 'authProvenance')
  if (typeof provenance !== 'string') {
    return null
  }
  const trimmed = provenance.trim()
  return trimmed.length > 0 ? trimmed : null
}

// Why: desktop Grok accounts prefer the weekly credit meter and fall back to
// the monthly included budget used by unified-billing accounts.
function readGrokWindowKey(limits: ProviderRateLimits | null): GrokUsageWindowKey | null {
  if (limits?.weekly) {
    return 'weekly'
  }
  if (limits?.monthly) {
    return 'monthly'
  }
  return null
}

export function getGrokAccountUsage(snapshot: AccountsSnapshot): GrokAccountUsage | null {
  const limits = readGrokLimits(snapshot)
  const authConfigured = readGrokAuthConfigured(snapshot)
  // Why: hide Grok when the desktop has neither a CLI session nor a usable meter,
  // so a Claude-only host does not grow an empty row.
  if (!authConfigured && !hasActiveProviderUsage(limits)) {
    return null
  }
  return {
    limits,
    label: readAuthProvenance(limits) ?? 'Signed in',
    windowKey: readGrokWindowKey(limits)
  }
}

// Why: the home card is omitted entirely unless some provider is worth showing.
// Grok-only desktops still need that card.
export function hostShowsAccountUsage(snapshot: AccountsSnapshot): boolean {
  return (
    hasRenderableUsage(snapshot, 'claude') ||
    hasRenderableUsage(snapshot, 'codex') ||
    getGrokAccountUsage(snapshot) != null
  )
}

function grokMeterPending(limits: ProviderRateLimits | null): boolean {
  return !limits || limits.status === 'idle' || limits.status === 'fetching'
}

export function getGrokUsageBarModel(usage: GrokAccountUsage, now: number): GrokUsageBarModel {
  const windowKey = usage.windowKey
  if (!windowKey) {
    return {
      windowLabel: '—',
      labelWidth: DEFAULT_LABEL_WIDTH,
      bar: getUsageBarState(usage.limits, 'weekly', grokMeterPending(usage.limits)),
      resetText: null
    }
  }
  return {
    windowLabel: windowKey === 'weekly' ? '7d' : '30d',
    labelWidth: windowKey === 'monthly' ? MONTHLY_LABEL_WIDTH : DEFAULT_LABEL_WIDTH,
    bar: getUsageBarState(usage.limits, windowKey),
    resetText: getWindowResetLabel(usage.limits, windowKey, now)
  }
}
