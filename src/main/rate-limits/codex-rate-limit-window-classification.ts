export const CODEX_SESSION_WINDOW_MINUTES = 300
export const CODEX_WEEKLY_WINDOW_MINUTES = 10080

// Why: tolerate the one-minute drift seen in older Codex bucket lengths without absorbing other durations.
const CODEX_WINDOW_DURATION_TOLERANCE_MINUTES = 1

export type CodexRpcRateWindow = {
  usedPercent?: unknown
  windowDurationMins?: unknown
  resetsAt?: unknown
}

export type CodexRpcRateLimits = {
  primary?: CodexRpcRateWindow | null
  secondary?: CodexRpcRateWindow | null
}

type MappableCodexRpcRateWindow = CodexRpcRateWindow & { usedPercent: number }
type CodexRateLimitWindowKind = 'session' | 'weekly' | null

function isMappableCodexRpcRateWindow(
  raw: CodexRpcRateWindow | null | undefined
): raw is MappableCodexRpcRateWindow {
  return typeof raw?.usedPercent === 'number' && Number.isFinite(raw.usedPercent)
}

function classifyWindowDuration(raw: MappableCodexRpcRateWindow): CodexRateLimitWindowKind {
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

export function classifyCodexRateLimitWindows(result: CodexRpcRateLimits | null | undefined): {
  session: MappableCodexRpcRateWindow | null
  weekly: MappableCodexRpcRateWindow | null
} {
  const primary = isMappableCodexRpcRateWindow(result?.primary) ? result.primary : null
  const secondary = isMappableCodexRpcRateWindow(result?.secondary) ? result.secondary : null
  let session: MappableCodexRpcRateWindow | null = null
  let weekly: MappableCodexRpcRateWindow | null = null

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
