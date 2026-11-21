import { z } from 'zod'
import { ProviderRateLimitsSchema, type AccountsSnapshot } from './accounts-snapshot'

const DeepSeekProviderRateLimitsSchema = ProviderRateLimitsSchema.extend({
  provider: z.literal('deepseek')
})

export type DeepSeekAccountUsageStatus =
  | 'loading'
  | 'available'
  | 'depleted'
  | 'refresh-error'
  | 'unavailable'

export type DeepSeekAccountUsage = {
  balanceLabel: string | null
  status: DeepSeekAccountUsageStatus
  statusLabel: string
}

function readDeepSeekAuthConfigured(snapshot: AccountsSnapshot): boolean {
  return snapshot.rateLimits['deepseekAuthConfigured'] === true
}

// Why: isolate the optional provider slot so a malformed DeepSeek payload cannot
// make the existing Claude/Codex account snapshot unreadable.
function readDeepSeekLimits(snapshot: AccountsSnapshot): {
  limits: z.infer<typeof DeepSeekProviderRateLimitsSchema> | null
  invalid: boolean
} {
  const raw = snapshot.rateLimits['deepseek']
  if (raw == null) {
    return { limits: null, invalid: false }
  }
  const parsed = DeepSeekProviderRateLimitsSchema.safeParse(raw)
  if (!parsed.success) {
    return { limits: null, invalid: true }
  }
  return { limits: parsed.data, invalid: false }
}

export function getDeepSeekAccountUsage(snapshot: AccountsSnapshot): DeepSeekAccountUsage | null {
  const { limits, invalid } = readDeepSeekLimits(snapshot)
  const monthly = limits?.monthly ?? null
  if (!readDeepSeekAuthConfigured(snapshot) && !monthly) {
    return null
  }

  const balanceLabel = monthly?.resetDescription?.trim() || null
  const isLoading = !limits || limits.status === 'idle' || limits.status === 'fetching'
  const status: DeepSeekAccountUsageStatus = invalid
    ? 'unavailable'
    : limits?.status === 'error' && monthly
      ? 'refresh-error'
      : monthly
        ? monthly.usedPercent >= 100
          ? 'depleted'
          : 'available'
        : isLoading
          ? 'loading'
          : 'unavailable'

  return {
    balanceLabel,
    status,
    statusLabel: getDeepSeekAccountUsageStatusLabel(status)
  }
}

export function hasDeepSeekAccountUsage(snapshot: AccountsSnapshot): boolean {
  return getDeepSeekAccountUsage(snapshot) !== null
}

function getDeepSeekAccountUsageStatusLabel(status: DeepSeekAccountUsageStatus): string {
  switch (status) {
    case 'loading':
      return 'Checking balance…'
    case 'available':
      return 'Balance available'
    case 'depleted':
      return 'No balance remaining'
    case 'refresh-error':
      return 'Balance refresh failed'
    case 'unavailable':
      return 'Balance unavailable'
  }
}
