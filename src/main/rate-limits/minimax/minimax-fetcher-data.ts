import type { ProviderRateLimits, RateLimitWindow } from '../../../shared/rate-limit-types'

export type MiniMaxUsageItem = {
  model_name?: unknown
  current_interval_remaining_percent?: unknown
  start_time?: unknown
  end_time?: unknown
  remains_time?: unknown
  // API percent uses the unboosted weekly base; weekly_boost_permille remains unparsed (handleMiniMaxWeeklyBoost).
  current_weekly_remaining_percent?: unknown
  weekly_remains_time?: unknown
  weekly_boost_permille?: unknown
}

export type MiniMaxUsageSnapshot = {
  modelName: string
  // Older/migrating schemas may omit weekly quota; session remains required.
  session: RateLimitWindow
  weekly: RateLimitWindow | null
}

export type MiniMaxModelList = string | readonly string[] | null | undefined

export function makeMiniMaxUnavailable(error: string): ProviderRateLimits {
  return {
    provider: 'minimax',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    usageMetadata: { failureKind: 'missing-credentials', source: 'web' }
  }
}

export function makeMiniMaxError(
  error: string,
  failureKind: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind'],
  // Localize credential-expiry guidance by source; raw errors remain English for logs.
  credentialSource?: 'api-key' | 'session-cookie'
): ProviderRateLimits {
  return {
    provider: 'minimax',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { failureKind, source: 'web', ...(credentialSource ? { credentialSource } : {}) }
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function parseMiniMaxModels(models: MiniMaxModelList): string[] {
  if (Array.isArray(models)) {
    const parsed = models.map((model) => model.trim()).filter(Boolean)
    return parsed.length > 0 ? parsed : ['general']
  }
  if (typeof models === 'string') {
    const parsed = models
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean)
    return parsed.length > 0 ? parsed : ['general']
  }
  return ['general']
}

// API durations can drift below 5h; label the contracted session window consistently.
const MINIMAX_SESSION_WINDOW_MINUTES = 300
// Weekly resets have only a remaining duration, anchored to now.
const MINIMAX_WEEKLY_WINDOW_MINUTES = 10080

export function parseMiniMaxUsageItem(value: unknown): MiniMaxUsageSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const item: MiniMaxUsageItem = value
  const modelName = typeof item.model_name === 'string' ? item.model_name : null
  const remainingPercent = asNumber(item.current_interval_remaining_percent)
  const startTime = asNumber(item.start_time)
  const endTime = asNumber(item.end_time)
  if (!modelName || remainingPercent === null || startTime === null || endTime === null) {
    return null
  }
  const session: RateLimitWindow = {
    usedPercent: clampPercent(100 - remainingPercent),
    windowMinutes: MINIMAX_SESSION_WINDOW_MINUTES,
    resetsAt: endTime,
    resetDescription: null
  }
  const weekly = parseMiniMaxWeeklyWindow(item)
  return { modelName, session, weekly }
}

export function parseMiniMaxWeeklyWindow(item: MiniMaxUsageItem): RateLimitWindow | null {
  const weeklyRemaining = asNumber(item.current_weekly_remaining_percent)
  if (weeklyRemaining === null) {
    return null
  }
  // weekly_remains_time uses the session remains_time duration units.
  const weeklyRemainsMs = asNumber(item.weekly_remains_time)
  return {
    usedPercent: clampPercent(100 - weeklyRemaining),
    windowMinutes: MINIMAX_WEEKLY_WINDOW_MINUTES,
    resetsAt: weeklyRemainsMs != null ? Date.now() + weeklyRemainsMs : null,
    resetDescription: null
  }
}

export function selectMiniMaxSnapshot(
  snapshots: MiniMaxUsageSnapshot[],
  preferredModels: string[]
): MiniMaxUsageSnapshot | null {
  for (const model of preferredModels) {
    const match = snapshots.find((snapshot) => snapshot.modelName === model)
    if (match) {
      return match
    }
  }
  return snapshots.length === 1 ? snapshots[0] : null
}
