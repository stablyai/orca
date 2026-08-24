import type { PtyProcessLivenessBrokerOptions } from './pty-process-liveness-broker-types'

export const DEFAULT_LIVE_TTL_MS = 10_000
export const DEFAULT_UNAVAILABLE_BACKOFF_BASE_MS = 3_000
export const DEFAULT_UNAVAILABLE_BACKOFF_MAX_MS = 30_000
export const DEFAULT_MAX_CONCURRENT_PROBES = 8
export const DEFAULT_MAX_CONCURRENT_UNSCOPED_PROBES = 4

export function processEvidenceKey(ptyId: string, identity: string): string {
  return JSON.stringify([ptyId, identity])
}

export function maxConcurrentProbes(options: PtyProcessLivenessBrokerOptions): number {
  const configured = options.maxConcurrentProbes ?? DEFAULT_MAX_CONCURRENT_PROBES
  return Number.isFinite(configured) && configured > 0
    ? Math.max(1, Math.floor(configured))
    : DEFAULT_MAX_CONCURRENT_PROBES
}

export function maxConcurrentUnscopedProbes(options: PtyProcessLivenessBrokerOptions): number {
  const configured = options.maxConcurrentUnscopedProbes ?? DEFAULT_MAX_CONCURRENT_UNSCOPED_PROBES
  return Number.isFinite(configured) && configured > 0
    ? Math.max(1, Math.floor(configured))
    : DEFAULT_MAX_CONCURRENT_UNSCOPED_PROBES
}
