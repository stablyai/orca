import type { ExtraUsageBalance } from '../../shared/rate-limit-types'

// Money is reported as minor units plus an exponent (e.g. 200000 @ exp 2 = €2000).
type OAuthMoney = {
  amount_minor?: number
  currency?: string
  exponent?: number
}

// The current "usage credits" shape: spent/limit as money, a live balance, and
// whether spending is currently possible. This is what Claude Code's own /usage
// panel renders as "Usage credits" (monthly spend limit + current balance).
export type ClaudeOAuthSpend = {
  used?: OAuthMoney
  limit?: OAuthMoney
  percent?: number
  enabled?: boolean
  disabled_reason?: string | null
  cap?: { money?: OAuthMoney | null } | null
  balance?: OAuthMoney | number | null
}

// Legacy shape kept as a fallback for older responses that only send `extra_usage`.
export type ClaudeOAuthExtraUsage = {
  is_enabled?: boolean
  monthly_limit?: number
  used_credits?: number
  utilization?: number
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

// Prefer the richer `spend` object; fall back to the legacy `extra_usage` shape.
export function mapClaudeExtraUsage(data: {
  spend?: ClaudeOAuthSpend
  extra_usage?: ClaudeOAuthExtraUsage
}): ExtraUsageBalance | null {
  return mapSpend(data.spend) ?? mapLegacyExtraUsage(data.extra_usage)
}

function mapSpend(spend: ClaudeOAuthSpend | undefined): ExtraUsageBalance | null {
  if (!spend) {
    return null
  }
  const spent = moneyToMajor(spend.used)
  const spendLimit = moneyToMajor(spend.limit) ?? moneyToMajor(spend.cap?.money)
  const balance = moneyToMajor(spend.balance) ?? 0
  // Nothing worth showing when the account has neither a configured cap nor a balance.
  if (spendLimit === null && balance === 0) {
    return null
  }
  const spentPercent =
    typeof spend.percent === 'number'
      ? clampPercent(spend.percent)
      : spendLimit !== null && spendLimit > 0 && spent !== null
        ? clampPercent((spent / spendLimit) * 100)
        : null
  return {
    balance,
    unit: 'currency',
    currencyCode:
      spend.used?.currency ?? spend.limit?.currency ?? spend.cap?.money?.currency ?? 'USD',
    enabled: spend.enabled === true,
    disabledReason: spend.disabled_reason ?? null,
    spent,
    spendLimit,
    spentPercent,
    resetsAt: null
  }
}

function mapLegacyExtraUsage(extra: ClaudeOAuthExtraUsage | undefined): ExtraUsageBalance | null {
  if (!extra || typeof extra.monthly_limit !== 'number') {
    return null
  }
  // Amounts are minor units; `decimal_places` gives the exponent (default cents).
  const divisor = 10 ** (typeof extra.decimal_places === 'number' ? extra.decimal_places : 2)
  const spendLimit = extra.monthly_limit / divisor
  const spent = typeof extra.used_credits === 'number' ? extra.used_credits / divisor : null
  const spentPercent =
    typeof extra.utilization === 'number'
      ? clampPercent(extra.utilization)
      : spendLimit > 0 && spent !== null
        ? clampPercent((spent / spendLimit) * 100)
        : null
  return {
    balance: 0,
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
