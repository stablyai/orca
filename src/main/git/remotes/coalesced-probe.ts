/** Stop joining stale probes so an unsettled host lookup cannot block all future retries. */

export type CoalescedProbe<T> = { startedAt: number; token: object; promise: Promise<T> }
export type CoalescedProbes<T> = Map<string, CoalescedProbe<T>>

// Retry after this age; elapsed time alone does not prove a probe has stopped progressing.
export const PROBE_COALESCE_STALE_MS = 60_000

/** ownsKey prevents an abandoned probe from publishing over its successor. */
export async function runCoalescedProbe<T>(
  probes: CoalescedProbes<T>,
  key: string,
  createProbe: (ownsKey: () => boolean) => Promise<T>,
  staleAfterMs: number = PROBE_COALESCE_STALE_MS,
  options: { userRefresh?: boolean } = {}
): Promise<T> {
  const now = Date.now()
  const existing = probes.get(key)
  if (!options.userRefresh && existing && now - existing.startedAt < staleAfterMs) {
    return existing.promise
  }
  if (existing) {
    // Observe failures from the abandoned probe, which may still be running.
    void existing.promise.catch(() => {})
  }
  const token = {}
  const entry: CoalescedProbe<T> = {
    startedAt: now,
    token,
    promise: createProbe(() => probes.get(key)?.token === token)
  }
  probes.set(key, entry)
  try {
    return await entry.promise
  } finally {
    if (probes.get(key) === entry) {
      probes.delete(key)
    }
  }
}
