/**
 * Coalescing for repeated host probes (P1-D).
 *
 * Why: the in-flight maps under the hosted-review funnel only drop a probe when
 * it settles, so one that never does pins every later retry for the life of the
 * process — the outer deadline then unpins the UI without restoring any lookup
 * progress. Joining a probe only while it is young enough to still be making
 * progress is what lets a host recover in-session.
 */

export type CoalescedProbe<T> = { startedAt: number; promise: Promise<T> }
export type CoalescedProbes<T> = Map<string, CoalescedProbe<T>>

/** Every step under a probe is bounded well inside this, so an older one is wedged, not slow. */
export const PROBE_COALESCE_STALE_MS = 60_000

export async function runCoalescedProbe<T>(
  probes: CoalescedProbes<T>,
  key: string,
  createProbe: () => Promise<T>,
  staleAfterMs: number = PROBE_COALESCE_STALE_MS
): Promise<T> {
  const now = Date.now()
  const existing = probes.get(key)
  if (existing && now - existing.startedAt < staleAfterMs) {
    return existing.promise
  }
  if (existing) {
    // The abandoned probe keeps running; nothing here will await it again.
    void existing.promise.catch(() => {})
  }
  const entry: CoalescedProbe<T> = { startedAt: now, promise: createProbe() }
  probes.set(key, entry)
  try {
    return await entry.promise
  } finally {
    if (probes.get(key) === entry) {
      probes.delete(key)
    }
  }
}
