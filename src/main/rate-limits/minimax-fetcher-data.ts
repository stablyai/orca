import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

// Why: pure data-shape helpers for the MiniMax Coding Plan API. Lives in its
// own file so both minimax-fetcher.ts (transport) and minimax-fetcher-parse.ts
// (response handling) can import without creating a dependency cycle.

export type MiniMaxUsageItem = {
  model_name?: unknown
  current_interval_remaining_percent?: unknown
  start_time?: unknown
  end_time?: unknown
  remains_time?: unknown
  // Why: Coding Plan also reports a separate 7-day quota. The API returns the
  // raw remaining percent against the un-boosted base; the opencode-tku
  // equivalent uses the value as-is. weekly_boost_permille exists in the
  // payload but is intentionally not parsed yet (see handleMiniMaxWeeklyBoost).
  current_weekly_remaining_percent?: unknown
  weekly_remains_time?: unknown
  weekly_boost_permille?: unknown
}

export type MiniMaxUsageSnapshot = {
  modelName: string
  // Why: weekly may be absent if the API omits it (older schema, mid-migration
  // window). Session is required (matches the existing parseUsageItem contract).
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
  failureKind: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind']
): ProviderRateLimits {
  return {
    provider: 'minimax',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { failureKind, source: 'web' }
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

// Why: MiniMax's API returns `end_time - start_time` that can drift below the
// 5-hour bucket (e.g. 4h or 295 min). The UI labels must reflect the contracted
// session — a fixed 5-hour window — so the status bar reads "5h" regardless of
// what the API reports. Mirrors how Codex always reports 300/10080 minutes.
const MINIMAX_SESSION_WINDOW_MINUTES = 300
// Why: 7-day window. The API doesn't expose a `weekly_end_time` analog of the
// session's end_time, so we label the chip via windowMinutes + a relative
// `resetsAt` derived from `weekly_remains_time` + now.
const MINIMAX_WEEKLY_WINDOW_MINUTES = 10080

export function parseMiniMaxUsageItem(item: MiniMaxUsageItem): MiniMaxUsageSnapshot | null {
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
  // Why: `weekly_remains_time` is a duration (matches `remains_time` units
  // for the 5h window). Anchor to `Date.now()` so the status bar's
  // countdown stays in lockstep with the session window shape.
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
