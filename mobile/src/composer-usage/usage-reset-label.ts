import { formatResetDuration } from '../../../src/shared/agent-usage/rate-limits/rate-limit-reset-format'
import { formatUsageWindowLength } from './agent-usage-provider'

/** `full` keeps two units ("3d 2h", "5h 20m"); `compact` keeps the largest ("3d", "5h"). */
export type UsageResetLabelDetail = 'full' | 'compact'

/** Time left until the window resets; its length ("7d") when no reset time is known. */
export function usageResetLabel(
  window: { windowMinutes: number; resetsAt: number | null },
  now: number,
  detail: UsageResetLabelDetail = 'full'
): string {
  if (window.resetsAt == null || !Number.isFinite(window.resetsAt)) {
    return formatUsageWindowLength(window.windowMinutes)
  }
  const ms = window.resetsAt - now
  if (ms <= 0) {
    return 'now'
  }
  if (ms < 60_000) {
    return '<1m'
  }
  const full = formatResetDuration(ms)
  return detail === 'compact' ? full.split(' ')[0] : full
}
