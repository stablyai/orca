import type { RateLimitWindow } from '../../shared/rate-limit-types'
import type { CodexRateWindowSnapshot } from './codex-rate-limit-window-classification'

export function mapCodexRateLimitWindow(
  raw: CodexRateWindowSnapshot | null | undefined,
  expectedWindowMinutes: number
): RateLimitWindow | null {
  if (!raw || typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) {
    return null
  }
  let resetDescription: string | null = null
  let resetsAt: number | null = null

  if (typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt) && raw.resetsAt > 0) {
    // Why: Codex returns resetsAt as Unix seconds, not milliseconds.
    const date = new Date(raw.resetsAt * 1000)
    if (!Number.isNaN(date.getTime())) {
      resetsAt = date.getTime()
      const now = new Date()
      const isToday = date.toDateString() === now.toDateString()
      resetDescription = isToday
        ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : date.toLocaleDateString(undefined, {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit'
          })
    }
  }

  return {
    usedPercent: Math.min(100, Math.max(0, raw.usedPercent)),
    // Why: older app-server builds can report canonical bucket lengths off by one minute.
    windowMinutes: expectedWindowMinutes,
    resetsAt,
    resetDescription
  }
}
