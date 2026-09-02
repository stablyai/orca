import type { RateLimitWindow } from '../../shared/rate-limit-types'

// Why: shared by the OAuth usage fetcher and the statusline live feed, whose window payloads share this shape.
export type ClaudeUsageWindowInput = {
  utilization?: number
  used_percentage?: number
  resets_at?: string | number
}

// Why: 1e10 sits between any plausible seconds epoch (<2286) and any millisecond epoch (>2001), so it distinguishes the two units without extra metadata.
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
