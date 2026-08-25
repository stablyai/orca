export const SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS = 30_000
// Why: kill switch — flip to disable producer flow control (pause/resume) without untangling the wiring.
export const PRODUCER_FLOW_CONTROL_ENABLED = true
// Why: mobile clients must mirror desktop PTY geometry even before the renderer can provide an xterm snapshot (e.g. right after tab creation).
export const ptySizes = new Map<string, { cols: number; rows: number }>()
// Why: the "recent user input" signal is PTY-scoped and must be cleared by every teardown path, incl. SSH/daemon shutdowns that skip the local exit listener.
export const lastInputAtByPty = new Map<string, number>()
export const interactiveOutputCharsByPty = new Map<string, number>()
export const activeRendererPtys = new Set<string>()
export const visibleRendererPtys = new Set<string>()
export const rendererVisibilityKnownPtys = new Set<string>()
export let invalidatePendingPtyDrainPriority = (_id?: string, _schedule?: boolean): void => {}
export let invalidatePendingPtyDrainPolicy = (_id?: string, _schedule?: boolean): void => {}
export const pendingHiddenRendererResizeOutputPtys = new Set<string>()
export const deliveredHiddenRendererResizeOutputPtys = new Set<string>()
export const KEEP_HISTORY_STOP_SETTLE_MS = 1_000
export const KEEP_HISTORY_STOP_POLL_MS = 100
// Why: after daemon keep-tail thinning main's mirror holds only the kept tail, so recovery must keep consulting the daemon's complete model until exit.
export const providerSnapshotRequiredPtys = new Set<string>()

export function setInvalidatePendingPtyDrainPriority(
  fn: (id?: string, schedule?: boolean) => void
): void {
  invalidatePendingPtyDrainPriority = fn
}

export function setInvalidatePendingPtyDrainPolicy(
  fn: (id?: string, schedule?: boolean) => void
): void {
  invalidatePendingPtyDrainPolicy = fn
}
