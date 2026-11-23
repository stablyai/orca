import type {
  WorktreeCatalogObservation,
  WorktreeCatalogRequirement,
  WorktreeCatalogVerifier
} from './repo-worktree-catalog-observation'
import { sameWorktreeCatalogStructure } from './worktree-catalog-structure'

export type RevalidationSlot = {
  timer: ReturnType<typeof setTimeout> | null
  /** Rows readers were handed past their window; whichever scan publishes next settles them. */
  served: WorktreeCatalogObservation | null
}

type RevalidationOwner = {
  repoId: string
  slot: RevalidationSlot
  flightRunning: () => boolean
  /** The served rows are still the owner's current publication. */
  stillServed: () => boolean
  start: () => Promise<unknown>
}

const revalidationListeners = new Set<(repoId: string) => void>()
// Stale reads release the renderer's per-repo request slots, so background scans need their own host-wide bound.
const MAX_BACKGROUND_REVALIDATIONS = 2
const BACKGROUND_RETRY_MS = 1_000
let activeBackgroundRevalidations = 0

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
  owner.slot.served ??= stale
  if (owner.flightRunning() || owner.slot.timer) {
    return
  }
  const arm = (delayMs: number): void => {
    // Converge without depending on a later read; a newer publication cancels this.
    owner.slot.timer = setTimeout(() => {
      owner.slot.timer = null
      if (!owner.flightRunning() && owner.stillServed()) {
        run()
      }
    }, delayMs)
    owner.slot.timer.unref?.()
  }
  const run = (): void => {
    if (activeBackgroundRevalidations >= MAX_BACKGROUND_REVALIDATIONS) {
      arm(BACKGROUND_RETRY_MS)
      return
    }
    activeBackgroundRevalidations += 1
    owner
      .start()
      .catch((error: unknown) => {
        console.warn('[worktrees] background catalog refresh failed:', error)
      })
      .finally(() => {
        activeBackgroundRevalidations -= 1
      })
  }
  const idleMs = stale.completedAt + (stale.completedAt - stale.startedAt) - now
  if (idleMs > 0) {
    arm(idleMs)
  } else {
    run()
  }
}

/** Fingerprint a background scan only when the rows it replaces carried one, so verifier readers keep reusing them. */
export function backgroundProbe(
  verifierProbe: WorktreeCatalogVerifier['probe'] | null,
  stale: WorktreeCatalogObservation
): Promise<string | null> | null {
  const probe = stale.adminFingerprint ? (verifierProbe?.() ?? null) : null
  return probe === 'in-flight' ? null : probe
}

/** Any scan's current publication tells readers that were served stale rows when the structure moved. */
export function settleServedStale(
  slot: RevalidationSlot,
  repoId: string,
  fresh: WorktreeCatalogObservation
): void {
  cancelRevalidation(slot)
  const served = slot.served
  slot.served = null
  if (!served || served === fresh || sameWorktreeCatalogStructure(served.outcome, fresh.outcome)) {
    return
  }
  for (const listener of revalidationListeners) {
    try {
      listener(repoId)
    } catch (error) {
      console.warn('[worktrees] catalog revalidation listener failed:', error)
    }
  }
}

export function cancelRevalidation(slot: RevalidationSlot): void {
  if (slot.timer) {
    clearTimeout(slot.timer)
    slot.timer = null
  }
}
