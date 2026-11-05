import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { DEFAULT_POLL_MS } from '../rate-limits/service/service-types'

export function currentTextAccountCapacity(
  observedAt: number,
  windows: (RateLimitWindow | null | undefined)[],
  now = Date.now()
): number | null {
  if (
    !Number.isFinite(observedAt) ||
    now < observedAt ||
    now - observedAt > DEFAULT_POLL_MS ||
    windows.length === 0
  ) {
    return null
  }
  if (
    windows.some(
      (window) =>
        !window ||
        !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 ||
        window.usedPercent > 100 ||
        (window.resetsAt !== null && (!Number.isFinite(window.resetsAt) || window.resetsAt <= now))
    )
  ) {
    return null
  }
  return Math.min(...windows.map((window) => 100 - window!.usedPercent))
}

export function providerTextAccountCapacity(
  limits: ProviderRateLimits | null | undefined,
  observedAt: number | undefined
): number | null {
  if (
    !limits ||
    limits.status !== 'ok' ||
    limits.error ||
    limits.usageMetadata?.failureKind ||
    limits.usageMetadata?.unverifiableOwner ||
    observedAt === undefined
  ) {
    return null
  }
  return currentTextAccountCapacity(observedAt, [limits.session, limits.weekly])
}

export function rankTextAccountsByCapacity(
  ids: string[],
  capacity: (id: string) => number | null
): string[] {
  return ids
    .map((id) => ({ id, room: capacity(id) }))
    .filter((a): a is { id: string; room: number } => a.room !== null && a.room > 0)
    .sort((a, b) => b.room - a.room || a.id.localeCompare(b.id))
    .map((a) => a.id)
}
