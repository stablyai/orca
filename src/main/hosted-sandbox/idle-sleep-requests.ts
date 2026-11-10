// The idle timer asks the window to run its ordinary Sleep, so the suspend that follows looks
// like any other. Remember the request per sandbox so that suspend tells the control plane it was
// the idle timer: only sleeps someone chose hold off predictive wake on every client.
export type HostedSuspendReason = 'idle' | 'user'

/** The window's Sleep normally lands within seconds of the request; an older one is stale. */
export const IDLE_SLEEP_REQUEST_TTL_MS = 60_000

const requested = new Map<string, number>()

export function noteIdleSleepRequested(sandboxId: string, now = Date.now()): void {
  requested.set(sandboxId, now)
}

/** Consumes the request: 'idle' when the idle timer asked for this sleep recently, else 'user'. */
export function takeSuspendReason(sandboxId: string, now = Date.now()): HostedSuspendReason {
  const at = requested.get(sandboxId)
  requested.delete(sandboxId)
  return at !== undefined && now - at <= IDLE_SLEEP_REQUEST_TTL_MS ? 'idle' : 'user'
}

/** Test seam. */
export function resetIdleSleepRequests(): void {
  requested.clear()
}
