// Wakes started on intent (before anyone opened the workspace). They fail without a trace: a
// refusal leaves the VM record as it was instead of saving a failed resume the row would show. A
// VM woken this way and never opened gets a short idle window; the lease scheduler still only
// sleeps it when its server reports no work (no agents, no recent terminal input), like any idle
// sleep. Opening the workspace (any wake without `quiet`) claims it back to the normal window.
const quiet = new Set<string>()
const unopened = new Set<string>()

/** Idle window for a VM woken on intent and not opened. */
export const UNOPENED_IDLE_STOP_MS = 3 * 60_000

export function markQuietWake(workspaceId: string): void {
  quiet.add(workspaceId)
}

/** The quiet wake woke the VM; it stays on the short idle window until claimed. */
export function noteQuietWakeWoke(workspaceId: string): void {
  if (quiet.has(workspaceId)) {
    unopened.add(workspaceId)
  }
}

export function claimQuietWake(workspaceId: string): void {
  quiet.delete(workspaceId)
  unopened.delete(workspaceId)
}

/** End of the quiet call: the wake is no longer in flight (an unopened VM stays marked). */
export function endQuietWake(workspaceId: string): void {
  quiet.delete(workspaceId)
}

export function isQuietWake(workspaceId: string): boolean {
  return quiet.has(workspaceId)
}

export function unopenedIdleStopMs(workspaceId: string | undefined): number | null {
  return workspaceId && unopened.has(workspaceId) ? UNOPENED_IDLE_STOP_MS : null
}
