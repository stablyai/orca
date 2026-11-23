export const SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS = 30_000
export const PRODUCER_FLOW_CONTROL_ENABLED = true
// Mobile needs PTY geometry before a renderer snapshot exists.
export const ptySizes = new Map<string, { cols: number; rows: number }>()
// Clear PTY-scoped input state on every teardown, including SSH/daemon paths without local exit callbacks.
export const lastInputAtByPty = new Map<string, number>()
export const interactiveOutputCharsByPty = new Map<string, number>()
export const activeRendererPtys = new Set<string>()
export const visibleRendererPtys = new Set<string>()
export const rendererVisibilityKnownPtys = new Set<string>()

// When no explicit active-PTY claim is registered, prioritize a sole visible PTY so active-pane
// resets or early rebinds do not downgrade a lone foreground terminal to 16KB background slicing.
export function getFallbackPrioritizedRendererPtyId(): string | undefined {
  if (activeRendererPtys.size > 0 || visibleRendererPtys.size !== 1) {
    return undefined
  }
  return visibleRendererPtys.values().next().value
}

export function isPrioritizedRendererPty(id: string): boolean {
  return activeRendererPtys.has(id) || getFallbackPrioritizedRendererPtyId() === id
}

export function invalidateFallbackPrioritizedRendererPtyChange(
  prevFallbackPtyId: string | undefined,
  opts: {
    excludeId?: string
    schedulePrev?: boolean
    scheduleNext?: boolean
    onPromoted?: (id: string) => void
  } = {}
): void {
  const nextFallbackPtyId = getFallbackPrioritizedRendererPtyId()
  if (prevFallbackPtyId === nextFallbackPtyId) {
    return
  }
  if (prevFallbackPtyId && prevFallbackPtyId !== opts.excludeId) {
    invalidatePendingPtyDrainPriority(prevFallbackPtyId, opts.schedulePrev)
  }
  if (nextFallbackPtyId) {
    if (nextFallbackPtyId !== opts.excludeId) {
      invalidatePendingPtyDrainPriority(nextFallbackPtyId, opts.scheduleNext)
    }
    opts.onPromoted?.(nextFallbackPtyId)
  }
}
// Visible attaches suppress main-start hiding; remember it so failed attaches can hide the PTY again.
export const attachingRendererViewPtys = new Map<string, { views: number; skippedHide: boolean }>()
/** A visible view, or one mid-attach, owns delivery; hiding it would drop output it is about to paint. */
export function isRendererViewShowingPty(id: string): boolean {
  return visibleRendererPtys.has(id) || attachingRendererViewPtys.has(id)
}

// Keep null-initialized wrapper bridges to avoid Rolldown no-op folding (STA-5661; see debug.ts).
let invalidatePendingPtyDrainPriorityImpl: ((id?: string, schedule?: boolean) => void) | null = null
let invalidatePendingPtyDrainPolicyImpl: ((id?: string, schedule?: boolean) => void) | null = null

export function invalidatePendingPtyDrainPriority(id?: string, schedule?: boolean): void {
  invalidatePendingPtyDrainPriorityImpl?.(id, schedule)
}

export function invalidatePendingPtyDrainPolicy(id?: string, schedule?: boolean): void {
  invalidatePendingPtyDrainPolicyImpl?.(id, schedule)
}
export const KEEP_HISTORY_STOP_SETTLE_MS = 1_000
export const KEEP_HISTORY_STOP_POLL_MS = 100
// Keep using provider snapshots after daemon tail thinning; main's mirror no longer holds full history.
export const providerSnapshotRequiredPtys = new Set<string>()

export function setInvalidatePendingPtyDrainPriority(
  fn: (id?: string, schedule?: boolean) => void
): void {
  invalidatePendingPtyDrainPriorityImpl = fn
}

export function setInvalidatePendingPtyDrainPolicy(
  fn: (id?: string, schedule?: boolean) => void
): void {
  invalidatePendingPtyDrainPolicyImpl = fn
}
