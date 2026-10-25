import type { ExtraUsageBalance, RateLimitWindow } from '../../shared/rate-limit-types'

const MONTHLY_WINDOW_MINUTES = 43_200

// Minor units use the reported exponent: 200000 at exponent 2 is 2000 currency units.
type OAuthMoney = {
  amount_minor?: number
  currency?: string
  exponent?: number
}

export type ClaudeOAuthSpend = {
  used?: OAuthMoney
  limit?: OAuthMoney
  percent?: number
  enabled?: boolean
  disabled_reason?: string | null
  cap?: { money?: OAuthMoney | null } | null
  balance?: OAuthMoney | number | null
}

// Older responses expose extra_usage without the richer spend object.
export type ClaudeOAuthExtraUsage = {
  is_enabled?: boolean
  monthly_limit?: number | null
  used_credits?: number | null
  utilization?: number | null
  currency?: string
  decimal_places?: number
  disabled_reason?: string | null
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function moneyToMajor(money: OAuthMoney | number | null | undefined): number | null {
  if (typeof money === 'number') {
    return Number.isFinite(money) ? money : null
  }
  if (!money || typeof money.amount_minor !== 'number' || !Number.isFinite(money.amount_minor)) {
    return null
  }
  const exponent = typeof money.exponent === 'number' ? money.exponent : 2
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    return null
  }
  return money.amount_minor / 10 ** exponent
}

export function mapClaudeExtraUsage(data: {
  spend?: ClaudeOAuthSpend
  extra_usage?: ClaudeOAuthExtraUsage
}): ExtraUsageBalance | null {
  return mapSpend(data.spend) ?? mapLegacyExtraUsage(data.extra_usage)
}

// Why: Enterprise seats have no 5h/7d windows; their monthly spend cap is the only limit that binds.
// Falls back to legacy `extra_usage` when `spend` carries only a balance.
export function mapClaudeSpendLimitWindow(data: {
  spend?: ClaudeOAuthSpend
  extra_usage?: ClaudeOAuthExtraUsage
}): RateLimitWindow | null {
  return (
    toSpendLimitWindow(mapSpend(data.spend)) ??
    toSpendLimitWindow(mapLegacyExtraUsage(data.extra_usage))
  )
}

function toSpendLimitWindow(extraUsage: ExtraUsageBalance | null): RateLimitWindow | null {
  if (
    extraUsage?.unit !== 'currency' ||
    extraUsage.spentPercent === null ||
    extraUsage.spendLimit === null ||
    extraUsage.spendLimit <= 0
  ) {
    return null
  }
  return {
    usedPercent: extraUsage.spentPercent,
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    resetsAt: extraUsage.resetsAt,
    resetDescription: null
  }
}

function mapSpend(spend: ClaudeOAuthSpend | undefined): ExtraUsageBalance | null {
  if (!spend) {
    return null
  }
  const spent = moneyToMajor(spend.used)
  const spendLimit = moneyToMajor(spend.limit) ?? moneyToMajor(spend.cap?.money)
  const balance = moneyToMajor(spend.balance)
  if (spendLimit === null && balance === null) {
    return null
  }
  const spentPercent =
    typeof spend.percent === 'number' && Number.isFinite(spend.percent)
      ? clampPercent(spend.percent)
      : spendLimit !== null && spendLimit > 0 && spent !== null
        ? clampPercent((spent / spendLimit) * 100)
        : null
  return {
    balance,
    unit: 'currency',
    currencyCode:
      spend.used?.currency ??
      spend.limit?.currency ??
      spend.cap?.money?.currency ??
      (typeof spend.balance === 'object' && spend.balance !== null
        ? spend.balance.currency
        : undefined) ??
      'USD',
    enabled: spend.enabled === true,
    disabledReason: spend.disabled_reason ?? null,
    spent,
    spendLimit,
    spentPercent,
    resetsAt: null
  }
}

function mapLegacyExtraUsage(extra: ClaudeOAuthExtraUsage | undefined): ExtraUsageBalance | null {
  if (!extra) {
    return null
  }
  const spendLimit = moneyToMajor({
    amount_minor: extra.monthly_limit ?? undefined,
    exponent: extra.decimal_places
  })
  if (spendLimit === null) {
    return null
  }
  const spent = moneyToMajor({
    amount_minor: extra.used_credits ?? undefined,
    exponent: extra.decimal_places
  })
  // Why amounts first: `utilization` has been seen as a 0–1 fraction as well as a percentage.
  const spentPercent =
    spendLimit > 0 && spent !== null
      ? clampPercent((spent / spendLimit) * 100)
      : typeof extra.utilization === 'number' && Number.isFinite(extra.utilization)
        ? clampPercent(extra.utilization)
        : null
  return {
    balance: null,
    unit: 'currency',
    currencyCode: extra.currency?.trim() || 'USD',
    enabled: extra.is_enabled === true,
    disabledReason: extra.disabled_reason ?? null,
    spent,
    spendLimit,
    spentPercent,
    resetsAt: null
  }
}
