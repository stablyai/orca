import type {
  WorktreeCatalogObservation,
  WorktreeCatalogRequirement
} from './repo-worktree-catalog-observation'

export type RevalidationSlot = {
  timer: ReturnType<typeof setTimeout> | null
  queued: boolean
  /** Readers were told to keep their rows; whichever scan publishes next owes them a re-list. */
  served: boolean
}

type RevalidationOwner = {
  repoId: string
  slot: RevalidationSlot
  flightRunning: () => boolean
  /** The rows readers were told to keep are still the owner's current publication. */
  stillServed: () => boolean
  start: () => Promise<unknown>
}

const revalidationListeners = new Set<(repoId: string) => void>()
// Stale reads release the renderer's per-repo request slots, so background scans need their own host-wide bound.
const MAX_BACKGROUND_REVALIDATIONS = 2
let activeBackgroundRevalidations = 0
const waitingRevalidations: (() => void)[] = []

/** A scan published after readers were told to keep their rows; they should list again. */
export function onWorktreeCatalogRevalidated(listener: (repoId: string) => void): () => void {
  revalidationListeners.add(listener)
  return () => revalidationListeners.delete(listener)
}

export function acceptable(
  observation: WorktreeCatalogObservation,
  requirement: WorktreeCatalogRequirement,
  now: number
): boolean {
  if (requirement.needsHygieneClaim?.() && !observation.witness?.hygieneDue) {
    return false
  }
  // Verifier confirmations are a runtime admission; other readers need a full observation that young.
  const basis = requirement.verifier ? observation.confirmedAt : observation.completedAt
  return now - basis <= requirement.maxAgeMs
}

export function servesStale(
  stale: WorktreeCatalogObservation,
  failure: WorktreeCatalogObservation | null,
  requirement: WorktreeCatalogRequirement,
  now: number
): boolean {
  const policy = requirement.staleWhileRevalidate
  return (
    policy !== undefined &&
    !requirement.needsHygieneClaim?.() &&
    // Fast scans keep wait-for-fresh; only scans slow enough to block readers answer from the last catalog.
    stale.completedAt - stale.startedAt >= policy.minScanMs &&
    now - stale.completedAt <= policy.maxStaleMs &&
    // A failed refresh since these rows means they can no longer be vouched for.
    (failure?.startedAt ?? -1) < stale.startedAt
  )
}

/** One background scan per owner, idle at least as long as the last scan ran, so slow repos never rescan back to back. */
export function revalidateInBackground(
  owner: RevalidationOwner,
  stale: WorktreeCatalogObservation,
  now: number
): void {
  owner.slot.served = true
  if (owner.flightRunning() || owner.slot.timer || owner.slot.queued) {
    return
  }
  const run = (): void => {
    owner.slot.queued = false
    if (owner.flightRunning() || !owner.stillServed()) {
      return
    }
    if (activeBackgroundRevalidations >= MAX_BACKGROUND_REVALIDATIONS) {
      owner.slot.queued = true
      waitingRevalidations.push(run)
      return
    }
    activeBackgroundRevalidations += 1
    Promise.resolve()
      .then(owner.start)
      .catch((error: unknown) => {
        console.warn('[worktrees] background catalog refresh failed:', error)
      })
      .finally(() => {
        activeBackgroundRevalidations -= 1
        waitingRevalidations.shift()?.()
      })
  }
  const idleMs = stale.completedAt + (stale.completedAt - stale.startedAt) - now
  if (idleMs <= 0) {
    run()
    return
  }
  // Converge without depending on a later read; a newer publication cancels this.
  owner.slot.timer = setTimeout(() => {
    owner.slot.timer = null
    run()
  }, idleMs)
  owner.slot.timer.unref?.()
}

/** Any scan's publication, success or failure, settles readers that were told to keep their rows. */
export function settleServedStale(slot: RevalidationSlot, repoId: string): void {
  cancelRevalidation(slot)
  if (!slot.served) {
    return
  }
  slot.served = false
  for (const listener of revalidationListeners) {
    try {
      listener(repoId)
    } catch (error) {
      console.warn('[worktrees] catalog revalidation listener failed:', error)
    }
  }
}

/** Queued runs re-check that their rows are still served, so a cancelled one simply lapses. */
export function cancelRevalidation(slot: RevalidationSlot): void {
  if (slot.timer) {
    clearTimeout(slot.timer)
    slot.timer = null
  }
  slot.queued = false
}
