export const CODEX_SESSION_WINDOW_MINUTES = 300
export const CODEX_WEEKLY_WINDOW_MINUTES = 10080

// Why: tolerate the one-minute drift seen in older Codex bucket lengths without absorbing other durations.
const CODEX_WINDOW_DURATION_TOLERANCE_MINUTES = 1

export type CodexRateWindowSnapshot = {
  usedPercent?: unknown
  windowDurationMins?: unknown
  resetsAt?: unknown
}

export type CodexRateLimitWindowsSnapshot = {
  primary?: CodexRateWindowSnapshot | null
  secondary?: CodexRateWindowSnapshot | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isReadableRateLimitWindow(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.usedPercent === 'number' && Number.isFinite(value.usedPercent)
  )
}

/**
 * False only for a wrapper that carries windows but none this build can read — the shape it
 * must not classify, because classifying it yields the same two nulls a real empty answer does.
 *
 * Why not "every window must read": one window Orca does not recognise beside one it does is a
 * readable answer. Rejecting it would discard live usage the day the app-server grows a window
 * shape, which is the harm this gate exists to prevent, pointed the other way.
 */
export function isReadableCodexRateLimitWindowsSnapshot(
  value: unknown
): value is CodexRateLimitWindowsSnapshot | null | undefined {
  if (value == null) {
    return true
  }
  if (!isRecord(value)) {
    return false
  }
  const windows = [value.primary, value.secondary]
  return windows.some(isReadableRateLimitWindow) || windows.every((window) => window == null)
}

type MappableCodexRateWindowSnapshot = CodexRateWindowSnapshot & { usedPercent: number }
type CodexRateLimitWindowKind = 'session' | 'weekly' | null

function isMappableCodexRateWindowSnapshot(
  raw: CodexRateWindowSnapshot | null | undefined
): raw is MappableCodexRateWindowSnapshot {
  return typeof raw?.usedPercent === 'number' && Number.isFinite(raw.usedPercent)
}

function classifyWindowDuration(raw: MappableCodexRateWindowSnapshot): CodexRateLimitWindowKind {
  const duration = raw.windowDurationMins
  if (typeof duration !== 'number' || !Number.isFinite(duration)) {
    return null
  }
  if (
    Math.abs(duration - CODEX_SESSION_WINDOW_MINUTES) <= CODEX_WINDOW_DURATION_TOLERANCE_MINUTES
  ) {
    return 'session'
  }
  if (Math.abs(duration - CODEX_WEEKLY_WINDOW_MINUTES) <= CODEX_WINDOW_DURATION_TOLERANCE_MINUTES) {
    return 'weekly'
  }
  return null
}

export function classifyCodexRateLimitWindows(
  result: CodexRateLimitWindowsSnapshot | null | undefined
): {
  session: MappableCodexRateWindowSnapshot | null
  weekly: MappableCodexRateWindowSnapshot | null
} {
  const primary = isMappableCodexRateWindowSnapshot(result?.primary) ? result.primary : null
  const secondary = isMappableCodexRateWindowSnapshot(result?.secondary) ? result.secondary : null
  let session: MappableCodexRateWindowSnapshot | null = null
  let weekly: MappableCodexRateWindowSnapshot | null = null

  for (const window of [primary, secondary]) {
    if (!window) {
      continue
    }
    const kind = classifyWindowDuration(window)
    if (kind === 'session' && !session) {
      session = window
    } else if (kind === 'weekly' && !weekly) {
      weekly = window
    }
  }

  // Why: unknown app-server durations retain Orca's legacy primary/session and secondary/weekly mapping.
  if (!session && primary && classifyWindowDuration(primary) === null) {
    session = primary
  }
  if (!weekly && secondary && classifyWindowDuration(secondary) === null) {
    weekly = secondary
  }

  return { session, weekly }
}
