import type { RateLimitBucket, RateLimitWindow } from '../../shared/rate-limit-types'

export type CodexRpcRateWindow = {
  usedPercent?: number
  windowDurationMins?: number
  resetsAt?: number
}

type CodexRpcRateLimitSnapshot = {
  limitId?: string
  limitName?: string
  primary?: CodexRpcRateWindow
  secondary?: CodexRpcRateWindow
}

export type CodexRpcRateLimitsPayload = {
  rateLimits?: CodexRpcRateLimitSnapshot
  rateLimitsByLimitId?: Record<string, CodexRpcRateLimitSnapshot | undefined> | null
}

type WindowMapper = (
  raw: CodexRpcRateWindow | undefined,
  windowMinutes: number
) => RateLimitWindow | null

function getWindowMinutes(reportedWindowMinutes: number | undefined, fallback: number): number {
  if (
    typeof reportedWindowMinutes !== 'number' ||
    !Number.isFinite(reportedWindowMinutes) ||
    reportedWindowMinutes <= 0
  ) {
    return fallback
  }
  return reportedWindowMinutes
}

function getPreferredSnapshot(payload: CodexRpcRateLimitsPayload | undefined): {
  id: string | null
  snapshot: CodexRpcRateLimitSnapshot | undefined
} {
  // Why: `rateLimits` is the app-server's declared preferred meter; choosing
  // the first by-id entry can replace compact session/weekly with another plan.
  if (payload?.rateLimits) {
    return {
      id: payload.rateLimits.limitId?.trim() || 'codex',
      snapshot: payload.rateLimits
    }
  }
  const byId = payload?.rateLimitsByLimitId
  if (byId?.codex) {
    return { id: 'codex', snapshot: byId.codex }
  }
  if (byId) {
    for (const [id, snapshot] of Object.entries(byId)) {
      if (snapshot) {
        return { id, snapshot }
      }
    }
  }
  return { id: null, snapshot: undefined }
}

function getSnapshotName(id: string, snapshot: CodexRpcRateLimitSnapshot): string {
  const name = snapshot.limitName?.trim() || snapshot.limitId?.trim() || id
  return name === 'codex' ? 'Session' : name
}

export function mapCodexRpcRateLimitsPayload(
  payload: CodexRpcRateLimitsPayload | undefined,
  mapWindow: WindowMapper
): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  buckets?: RateLimitBucket[]
} {
  const preferred = getPreferredSnapshot(payload)
  const session = mapWindow(
    preferred.snapshot?.primary,
    getWindowMinutes(preferred.snapshot?.primary?.windowDurationMins, 300)
  )
  const weekly = mapWindow(
    preferred.snapshot?.secondary,
    getWindowMinutes(preferred.snapshot?.secondary?.windowDurationMins, 10080)
  )
  const byId = payload?.rateLimitsByLimitId
  if (!byId) {
    return { session, weekly }
  }

  const buckets: RateLimitBucket[] = []
  for (const [id, snapshot] of Object.entries(byId)) {
    if (!snapshot || id === (preferred.id ?? 'codex')) {
      continue
    }
    const name = getSnapshotName(id, snapshot)
    const primary = mapWindow(
      snapshot.primary,
      getWindowMinutes(snapshot.primary?.windowDurationMins, 300)
    )
    if (primary) {
      buckets.push({ name, ...primary })
    }
    const secondary = mapWindow(
      snapshot.secondary,
      getWindowMinutes(snapshot.secondary?.windowDurationMins, 10080)
    )
    if (secondary) {
      buckets.push({ name: `${name} weekly`, ...secondary })
    }
  }

  return { session, weekly, ...(buckets.length > 0 ? { buckets } : {}) }
}
