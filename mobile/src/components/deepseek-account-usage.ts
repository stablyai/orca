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

function readField(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key]
}

function readDeepSeekAuthConfigured(snapshot: AccountsSnapshot): boolean {
  return readField(snapshot.rateLimits, 'deepseekAuthConfigured') === true
}

// Why: isolate the optional provider slot so a malformed DeepSeek payload cannot
// make the existing Claude/Codex account snapshot unreadable.
function readDeepSeekLimits(
  snapshot: AccountsSnapshot
): z.infer<typeof DeepSeekProviderRateLimitsSchema> | null {
  const raw = readField(snapshot.rateLimits, 'deepseek')
  if (raw == null) {
    return null
  }
  const parsed = DeepSeekProviderRateLimitsSchema.safeParse(raw)
  if (!parsed.success) {
    return null
  }
  return parsed.data
}

export function getDeepSeekAccountUsage(snapshot: AccountsSnapshot): DeepSeekAccountUsage | null {
  const limits = readDeepSeekLimits(snapshot)
  const monthly = limits?.monthly ?? null
  if (!readDeepSeekAuthConfigured(snapshot) && !monthly) {
    return null
  }

  const balanceLabel = monthly?.resetDescription?.trim() || null
  const isLoading = !limits || limits.status === 'idle' || limits.status === 'fetching'
  const status: DeepSeekAccountUsageStatus =
    limits?.status === 'error' && monthly
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
