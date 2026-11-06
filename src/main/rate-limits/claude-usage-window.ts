import type { RateLimitWindow } from '../../shared/rate-limit-types'

export type ClaudeUsageWindowInput = {
  utilization?: number
  used_percentage?: number
  resets_at?: string | number
}

// 1e10 separates plausible epoch seconds (before 2286) from milliseconds (after 2001).
export function parseClaudeUsageResetTimestamp(value: string | number | undefined): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null
    }
    return value > 10_000_000_000 ? value : value * 1000
  }

  if (!value) {
    return null
  }

  const numericValue = Number(value)
  if (Number.isFinite(numericValue) && value.trim() !== '') {
    return numericValue > 10_000_000_000 ? numericValue : numericValue * 1000
  }

  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function parseClaudeUsageResetDescription(resetValue: string | number | undefined): string | null {
  const resetTimestamp = parseClaudeUsageResetTimestamp(resetValue)
  if (resetTimestamp === null) {
    return null
  }
  try {
    const date = new Date(resetTimestamp)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()
    if (isToday) {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    }
    return date.toLocaleDateString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit'
    })
  } catch {
    return null
  }
}

export function mapClaudeUsageWindow(
  raw: ClaudeUsageWindowInput | undefined,
  windowMinutes: number
): RateLimitWindow | null {
  if (!raw) {
    return null
  }
  const usedPercent =
    typeof raw.utilization === 'number'
      ? raw.utilization
      : typeof raw.used_percentage === 'number'
        ? raw.used_percentage
        : null
  if (usedPercent === null) {
    return null
  }
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt: parseClaudeUsageResetTimestamp(raw.resets_at),
    resetDescription: parseClaudeUsageResetDescription(raw.resets_at)
  }
}

// Same-window statusline/OAuth reset precision differs; separate windows are hours apart.
const SAME_WINDOW_TOLERANCE_MS = 60 * 1000

function isSameClaudeUsageReset(a: number | null, b: number | null): boolean {
  return a === null || b === null ? a === b : Math.abs(a - b) <= SAME_WINDOW_TOLERANCE_MS
}

export function isSameClaudeUsageWindow(
  a: RateLimitWindow | null,
  b: RateLimitWindow | null
): boolean {
  return a && b
    ? a.usedPercent === b.usedPercent && isSameClaudeUsageReset(a.resetsAt, b.resetsAt)
    : a === b
}

// Within one window usage grows; a lower value or older reset is an idle session's stale snapshot.
export function isStaleClaudeUsageWindow(
  previous: RateLimitWindow | null | undefined,
  incoming: RateLimitWindow,
  now: number
): boolean {
  if (!previous || previous.resetsAt === null || incoming.resetsAt === null) {
    return false
  }
  if (previous.resetsAt <= now) {
    return false
  }
  if (incoming.resetsAt < previous.resetsAt - SAME_WINDOW_TOLERANCE_MS) {
    return true
  }
  return (
    isSameClaudeUsageReset(incoming.resetsAt, previous.resetsAt) &&
    incoming.usedPercent < previous.usedPercent
  )
}
