import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  classifyCodexRateLimitWindows,
  CODEX_SESSION_WINDOW_MINUTES,
  CODEX_WEEKLY_WINDOW_MINUTES,
  type CodexRateLimitWindowsSnapshot
} from './codex-rate-limit-window-classification'
import { mapCodexCredits } from './codex-credit-balance'
import { mapCodexRateLimitWindow } from './codex-rate-limit-window-mapper'
import {
  mapRpcRateLimitResetCredits,
  type RpcRateLimitResetCredits
} from './codex-reset-credit-client'

export type RpcRateLimitsResponse = {
  rateLimits?: CodexRateLimitWindowsSnapshot | null
  rateLimitResetCredits?: RpcRateLimitResetCredits
}

export function mapCodexRpcRateLimits(wrapper: RpcRateLimitsResponse): ProviderRateLimits {
  const classified = classifyCodexRateLimitWindows(wrapper?.rateLimits)
  const credits = mapRpcRateLimitResetCredits(wrapper?.rateLimitResetCredits)
  const extraUsage = mapCodexCredits(wrapper?.rateLimits?.credits)
  return {
    provider: 'codex',
    session: mapCodexRateLimitWindow(classified.session, CODEX_SESSION_WINDOW_MINUTES),
    weekly: mapCodexRateLimitWindow(classified.weekly, CODEX_WEEKLY_WINDOW_MINUTES),
    ...(credits !== undefined ? { rateLimitResetCredits: credits } : {}),
    ...(extraUsage ? { extraUsage } : {}),
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}
