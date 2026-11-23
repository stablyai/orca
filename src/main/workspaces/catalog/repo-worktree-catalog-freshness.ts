import type {
  WorktreeCatalogObservation,
  WorktreeCatalogRequirement
} from './repo-worktree-catalog-observation'
import { sameWorktreeCatalogStructure } from './worktree-catalog-structure'

export type RevalidationSlot = { timer: ReturnType<typeof setTimeout> | null }

type RevalidationOwner = {
  repoId: string
  slot: RevalidationSlot
  flightRunning: () => boolean
  /** The served rows are still the owner's current publication. */
  stillServed: () => boolean
  start: () => Promise<WorktreeCatalogObservation>
  published: (fresh: WorktreeCatalogObservation) => boolean
}

const revalidationListeners = new Set<(repoId: string) => void>()

/** A background refresh published rows whose structure differs from the ones readers were served. */
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
  if (owner.flightRunning() || owner.slot.timer) {
    return
  }
  const run = (): void => {
    void owner.start().then((fresh) => {
      if (!owner.published(fresh) || sameWorktreeCatalogStructure(stale.outcome, fresh.outcome)) {
        return
      }
      for (const listener of revalidationListeners) {
        try {
          listener(owner.repoId)
        } catch (error) {
          console.warn('[worktrees] catalog revalidation listener failed:', error)
        }
      }
    })
  }
  const idleMs = stale.completedAt + (stale.completedAt - stale.startedAt) - now
  if (idleMs <= 0) {
    run()
    return
  }
  // Converge without depending on a later read.
  owner.slot.timer = setTimeout(() => {
    owner.slot.timer = null
    if (!owner.flightRunning() && owner.stillServed()) {
      run()
    }
  }, idleMs)
  owner.slot.timer.unref?.()
}

export function cancelRevalidation(slot: RevalidationSlot): void {
  if (slot.timer) {
    clearTimeout(slot.timer)
    slot.timer = null
  }
}
