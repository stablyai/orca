import {
  classifyCodexRateLimitWindows,
  CODEX_SESSION_WINDOW_MINUTES,
  CODEX_WEEKLY_WINDOW_MINUTES,
  type CodexRateLimitWindowsSnapshot,
  type CodexRateWindowSnapshot
} from './codex-rate-limit-window-classification'
import type { RateLimitBucket, RateLimitWindow } from '../../shared/rate-limit-types'

type CodexRpcRateLimitSnapshot = CodexRateLimitWindowsSnapshot & {
  limitId?: string
  limitName?: string
}

export type CodexRpcRateLimitsPayload = {
  // Why: app-server may return rateLimits:null; treat null like missing preferred meter.
  rateLimits?: CodexRpcRateLimitSnapshot | null
  rateLimitsByLimitId?: Record<string, CodexRpcRateLimitSnapshot | undefined> | null
}

type WindowMapper = (
  raw: CodexRateWindowSnapshot | undefined,
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

function getPreferredSnapshotId(payload: CodexRpcRateLimitsPayload | undefined): string | null {
  // Why: `rateLimits` is the app-server's declared preferred meter; its id
  // (or the 'codex' default) must not reappear as an extra bucket.
  if (payload?.rateLimits) {
    return payload.rateLimits.limitId?.trim() || 'codex'
  }
  return null
}

function getSnapshotName(id: string, snapshot: CodexRpcRateLimitSnapshot): string {
  const name = snapshot.limitName?.trim() || snapshot.limitId?.trim() || id
  return name === 'codex' ? 'Session' : name
}

export function mapCodexRpcRateLimitBuckets(
  payload: CodexRpcRateLimitsPayload | undefined,
  mapWindow: WindowMapper
): RateLimitBucket[] | undefined {
  const byId = payload?.rateLimitsByLimitId
  if (!byId) {
    return undefined
  }
  const preferredId = getPreferredSnapshotId(payload) ?? 'codex'
  const buckets: RateLimitBucket[] = []
  for (const [id, snapshot] of Object.entries(byId)) {
    if (!snapshot || id === preferredId) {
      continue
    }
    const name = getSnapshotName(id, snapshot)
    // Why: classification picks which slot is session vs weekly; the reported
    // duration stays the bucket's windowMinutes (it needn't be 300/10080).
    const { session, weekly } = classifyCodexRateLimitWindows(snapshot)
    const sessionWindow = mapWindow(
      session ?? undefined,
      getWindowMinutes(
        typeof session?.windowDurationMins === 'number' ? session.windowDurationMins : undefined,
        CODEX_SESSION_WINDOW_MINUTES
      )
    )
    if (sessionWindow) {
      buckets.push({ name, ...sessionWindow })
    }
    const weeklyWindow = mapWindow(
      weekly ?? undefined,
      getWindowMinutes(
        typeof weekly?.windowDurationMins === 'number' ? weekly.windowDurationMins : undefined,
        CODEX_WEEKLY_WINDOW_MINUTES
      )
    )
    if (weeklyWindow) {
      buckets.push({ name: `${name} weekly`, ...weeklyWindow })
    }
  }
  return buckets.length > 0 ? buckets : undefined
}
