import type { ExtraUsageBalance } from '../../shared/rate-limit-types'
import type { CodexRateLimitWindowsSnapshot } from './codex-rate-limit-window-classification'

type RpcCredits = NonNullable<CodexRateLimitWindowsSnapshot['credits']>

// Credits are unitless, not currency; suppress empty balances for accounts that never bought credits.
export function mapCodexCredits(raw: RpcCredits | null | undefined): ExtraUsageBalance | null {
  if (!raw || (raw.hasCredits !== true && raw.unlimited !== true)) {
    return null
  }
  const parsed =
    typeof raw.balance === 'string' && raw.balance.trim() !== '' ? Number(raw.balance) : raw.balance
  if ((typeof parsed !== 'number' || !Number.isFinite(parsed)) && raw.unlimited !== true) {
    return null
  }
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
