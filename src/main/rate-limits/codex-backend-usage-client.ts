import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import {
  classifyCodexRateLimitWindows,
  CODEX_SESSION_WINDOW_MINUTES,
  CODEX_WEEKLY_WINDOW_MINUTES,
  type CodexRateWindowSnapshot
} from './codex-rate-limit-window-classification'
import {
  createCodexBackendRequestSignal,
  getCodexBackendAuthHeaders,
  type CodexBackendRequest
} from './codex-backend-auth'
import type { CodexRateLimitFetchOptions } from './codex-rate-limit-fetch-options'
import { mapCodexRateLimitWindow } from './codex-rate-limit-window-mapper'
import { mapBackendRateLimitResetCredits } from './codex-reset-credit-client'

type BackendRateLimitWindow = {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
}

type BackendUsageResponse = {
  plan_type?: string
  rate_limit?: {
    primary_window?: BackendRateLimitWindow | null
    secondary_window?: BackendRateLimitWindow | null
  } | null
  rate_limit_reset_credits?: Parameters<typeof mapBackendRateLimitResetCredits>[0]
}

function backendWindowToSnapshot(
  raw: BackendRateLimitWindow | null | undefined
): CodexRateWindowSnapshot | null {
  if (!raw) {
    return null
  }
  const limitWindowSeconds = raw.limit_window_seconds
  const windowDurationMins =
    typeof limitWindowSeconds === 'number' &&
    Number.isFinite(limitWindowSeconds) &&
    limitWindowSeconds > 0
      ? Math.ceil(limitWindowSeconds / 60)
      : undefined
  return { usedPercent: raw.used_percent, windowDurationMins, resetsAt: raw.reset_at }
}

function snapshotWindowMinutes(
  snapshot: CodexRateWindowSnapshot | null,
  fallbackWindowMinutes: number
): number {
  const duration = snapshot?.windowDurationMins
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    ? duration
    : fallbackWindowMinutes
}

export async function fetchCodexRateLimitsViaBackend(
  request: CodexBackendRequest,
  options?: CodexRateLimitFetchOptions
): Promise<ProviderRateLimits | null> {
  const signal = createCodexBackendRequestSignal(options?.signal)
  const headers = await getCodexBackendAuthHeaders(options, signal)
  if (!headers || signal.aborted) {
    return null
  }
  const response = await request('https://chatgpt.com/backend-api/wham/usage', { headers, signal })
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    return null
  }
  const payload = (await response.json()) as BackendUsageResponse
  if (typeof payload.plan_type !== 'string') {
    return null
  }
  const classified = classifyCodexRateLimitWindows({
    primary: backendWindowToSnapshot(payload.rate_limit?.primary_window),
    secondary: backendWindowToSnapshot(payload.rate_limit?.secondary_window)
  })
  return {
    provider: 'codex',
    session: mapCodexRateLimitWindow(
      classified.session,
      snapshotWindowMinutes(classified.session, CODEX_SESSION_WINDOW_MINUTES)
    ),
    weekly: mapCodexRateLimitWindow(
      classified.weekly,
      snapshotWindowMinutes(classified.weekly, CODEX_WEEKLY_WINDOW_MINUTES)
    ),
    planType: payload.plan_type,
    ...(payload.rate_limit_reset_credits !== undefined
      ? {
          rateLimitResetCredits:
            mapBackendRateLimitResetCredits(payload.rate_limit_reset_credits) ?? null
        }
      : {}),
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

export async function supplementCodexSessionWindow(
  limits: ProviderRateLimits,
  request: CodexBackendRequest,
  options?: CodexRateLimitFetchOptions
): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted || limits.session || !limits.weekly) {
    return limits
  }
  try {
    const backend = await fetchCodexRateLimitsViaBackend(request, options)
    if (!backend) {
      return limits
    }
    const rateLimitResetCredits = backend.rateLimitResetCredits ?? limits.rateLimitResetCredits
    if (!backend.session) {
      return rateLimitResetCredits === limits.rateLimitResetCredits
        ? limits
        : { ...limits, rateLimitResetCredits }
    }
    return {
      ...limits,
      session: backend.session,
      weekly: backend.weekly ?? limits.weekly,
      planType: backend.planType ?? limits.planType,
      ...(rateLimitResetCredits !== undefined ? { rateLimitResetCredits } : {}),
      updatedAt: backend.updatedAt
    }
  } catch {
    return limits
  }
}
