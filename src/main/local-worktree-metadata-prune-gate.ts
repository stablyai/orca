/**
 * Decides whether a detected-worktree scan owes the store a metadata-hygiene pass.
 *
 * The pass captures a prune expectation over the repo's whole metadata table, `stat`s every
 * path-missing candidate, then prunes metadata and lineage. That is O(all rows) and destructive, so
 * it must not ride a polled read path: on a store whose dangling rows outnumber live worktrees
 * ~100:1 it re-derives an answer it already has, forever, pinning the main process in filesystem
 * completion callbacks (#17775). Rows pinned by a persisted session are never removable, so the
 * repetition cannot even make progress.
 *
 * Nothing the pass reads changes on its own, so it is gated on evidence rather than a clock:
 *  - a worktree lifecycle event for the repo (the existing worktree-change invalidator hub),
 *  - a mutation that can make some row *more* removable (see `invalidate…PruneInputs`),
 *  - the repo's git listing differing from the one the last pass ran against.
 * With none of those, the pass is a provable repeat and is skipped outright.
 *
 * Why only "more removable" mutations count: the listing path itself writes worktree metadata
 * (discovery backfill, host-ownership stamping), so bumping on every metadata write would re-arm
 * the gate from the very scan it gates and restore the storm. Additions and updates can only
 * preserve more rows, so staleness there is harmless.
 *
 * The failure direction is deliberate. A signal we miss leaves a dangling row in place until the
 * next one arrives — hygiene lags, and nothing is deleted that would not have been deleted anyway.
 */

/** Bumped by evidence that some row may have become removable; repos re-run the pass once each. */
let pruneInputsGeneration = 0
const observedGenerationByRepo = new Map<string, number>()
const listingFingerprintByRepo = new Map<string, string>()

/** True until the repo has run a pass against the current generation — so also on the first scan. */
export function isLocalWorktreeMetadataPruneDue(repoId: string): boolean {
  return observedGenerationByRepo.get(repoId) !== pruneInputsGeneration
}

/**
 * Claim the pending pass. Recorded when the expectation is captured rather than when the prune
 * finishes: a scan that is invalidated or fails mid-flight must not re-arm the full capture on the
 * very next listing poll, and any real change re-bumps the generation anyway.
 */
export function markLocalWorktreeMetadataPruneStarted(repoId: string): void {
  observedGenerationByRepo.set(repoId, pruneInputsGeneration)
}

/** One repo's worktrees changed (create/remove/rename). */
export function requireLocalWorktreeMetadataPrune(repoId: string): void {
  observedGenerationByRepo.delete(repoId)
}

/**
 * Some metadata row may have become removable — a worktree-meta/identity/lineage row was deleted,
 * or a session, lease, automation or selection released its claim on a workspace. Repo-agnostic
 * because ownership is global state: a session release can unpin a row in any repo.
 */
export function invalidateLocalWorktreeMetadataPruneInputs(): void {
  pruneInputsGeneration += 1
}

/**
 * Backstop for changes no event reported: if Git now lists a different set of worktrees than the
 * last pass ran against, that pass's conclusions no longer describe this repo. Costs one join over
 * a list we already hold.
 */
export function recordLocalWorktreeListingForPruneGate(
  repoId: string,
  worktreePaths: readonly string[]
): void {
  const fingerprint = [...worktreePaths].sort().join('\0')
  const previous = listingFingerprintByRepo.get(repoId)
  if (previous === fingerprint) {
    return
  }
  listingFingerprintByRepo.set(repoId, fingerprint)
  // Why not on the first listing: a repo we have never scanned is already due by default, and the
  // scan that produced this listing is the pass that covers it. Re-arming here would double it.
  if (previous !== undefined) {
    requireLocalWorktreeMetadataPrune(repoId)
  }
}

/** A deregistered repo leaves no reason to retain its gate state. */
export function forgetLocalWorktreeMetadataPruneGate(repoId: string): void {
  observedGenerationByRepo.delete(repoId)
  listingFingerprintByRepo.delete(repoId)
}

export function __resetLocalWorktreeMetadataPruneGateForTests(): void {
  pruneInputsGeneration = 0
  observedGenerationByRepo.clear()
  listingFingerprintByRepo.clear()
}

/** Repo teardown: a full removal retires this repo's gate, and either shape can unpin rows in
 *  other repos, so the shared inputs are always re-armed. */
export function retireLocalWorktreeMetadataPruneStateForRepo(
  repoId: string,
  hostId: string | null
): void {
  if (hostId === null) {
    forgetLocalWorktreeMetadataPruneGate(repoId)
  }
  invalidateLocalWorktreeMetadataPruneInputs()
}
