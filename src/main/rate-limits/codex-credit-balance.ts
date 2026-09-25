import type { ExtraUsageBalance } from '../../shared/rate-limit-types'
import type { CodexRateLimitWindowsSnapshot } from './codex-rate-limit-window-classification'

// Codex's pay-as-you-go credit balance, reported alongside the rate windows.
// `balance` is a plain credit count (string), not a currency amount.
type RpcCredits = NonNullable<CodexRateLimitWindowsSnapshot['credits']>

// Codex credits are a unitless count, not currency. Only surface the balance
// when the account actually has credits (or unlimited) so accounts that never
// bought any don't get an empty "0 credits" row.
export function mapCodexCredits(raw: RpcCredits | null | undefined): ExtraUsageBalance | null {
  if (!raw || (raw.hasCredits !== true && raw.unlimited !== true)) {
    return null
  }
  const parsed = typeof raw.balance === 'string' ? Number(raw.balance) : raw.balance
  const balance = typeof parsed === 'number' && Number.isFinite(parsed) ? Math.max(0, parsed) : 0
  return {
    balance,
    unit: 'credits',
    unlimited: raw.unlimited === true,
    enabled: raw.hasCredits === true || raw.unlimited === true,
    disabledReason: null,
    resetsAt: null
  }
}
