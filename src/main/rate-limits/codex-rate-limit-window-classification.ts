import type { RateLimitWindow } from '../../shared/rate-limit-types'

export const CODEX_SESSION_WINDOW_MINUTES = 300
export const CODEX_WEEKLY_WINDOW_MINUTES = 10_080

const CODEX_RPC_WINDOW_ROUNDING_TOLERANCE_MINUTES = 1

export function isCodexWeeklyWindowDuration(windowMinutes: number | undefined): boolean {
  return (
    typeof windowMinutes === 'number' &&
    Number.isFinite(windowMinutes) &&
    Math.abs(windowMinutes - CODEX_WEEKLY_WINDOW_MINUTES) <=
      CODEX_RPC_WINDOW_ROUNDING_TOLERANCE_MINUTES
  )
}

export function classifyCodexRateLimitWindows(
  primary: RateLimitWindow | null,
  secondary: RateLimitWindow | null
): { session: RateLimitWindow | null; weekly: RateLimitWindow | null } {
  // Why: newer Codex plans can expose their sole weekly quota as the primary
  // window, so field position alone no longer identifies a five-hour session.
  if (primary && !secondary && isCodexWeeklyWindowDuration(primary.windowMinutes)) {
    return { session: null, weekly: primary }
  }

  return { session: primary, weekly: secondary }
}
