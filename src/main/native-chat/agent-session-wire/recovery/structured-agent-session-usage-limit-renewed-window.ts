import { rateLimitShowsRoom } from '../../../../shared/agent-usage/rate-limits/rate-limit-spent-windows'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { NativeChatUsageLimitCut } from '../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'

// Errors round their reset to the minute; a window that started over ends hours later.
const RENEWED_WINDOW_MARGIN_MS = 10 * 60_000

/** When the account-wide window that stopped the cut started over early (a redeemed reset), the
 *  reading's time. Room alone is not enough: a reading can lag the limit it just hit. */
export function usageLimitWindowRenewedAt(
  cut: Pick<NativeChatUsageLimitCut, 'window' | 'turnEndedAt'> & { resetsAt: number },
  reading: ProviderRateLimits
): number | undefined {
  if (
    (cut.window !== 'session' && cut.window !== 'weekly') ||
    cut.turnEndedAt === undefined ||
    reading.status !== 'ok' ||
    reading.usageMetadata?.source === 'live-session' ||
    reading.updatedAt <= cut.turnEndedAt ||
    !rateLimitShowsRoom(reading)
  ) {
    return undefined
  }
  const window = reading[cut.window]
  if (!window || window.usedPercent >= 100) {
    return undefined
  }
  const renewed =
    window.resetsAt === null
      ? window.usedPercent === 0
      : window.resetsAt > cut.resetsAt + RENEWED_WINDOW_MARGIN_MS
  return renewed ? reading.updatedAt : undefined
}
