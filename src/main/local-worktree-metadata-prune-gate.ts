// Pruning scans all metadata: rerun on removal evidence, never on every listing poll (#17775).
// Ignore additions/updates: discovery writes metadata itself, and retaining extra rows is safe.

let pruneInputsGeneration = 0
const observedGenerationByRepo = new Map<string, number>()
const listingFingerprintByRepo = new Map<string, string>()

/** Unseen repos are due on their first scan. */
export function isLocalWorktreeMetadataPruneDue(repoId: string): boolean {
  return observedGenerationByRepo.get(repoId) !== pruneInputsGeneration
}

/** Claim before pruning so failures do not retry on every poll; new evidence rearms the pass. */
export function markLocalWorktreeMetadataPruneStarted(repoId: string): void {
  observedGenerationByRepo.set(repoId, pruneInputsGeneration)
}

export function requireLocalWorktreeMetadataPrune(repoId: string): void {
  observedGenerationByRepo.delete(repoId)
}

/** Deletions and released claims can unpin rows in any repo; invalidate globally. */
export function invalidateLocalWorktreeMetadataPruneInputs(): void {
  pruneInputsGeneration += 1
}

/** Changed Git listings catch worktree mutations that emitted no event. */
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
  // First listings are already due; rearming would duplicate their pass.
  if (previous !== undefined) {
    requireLocalWorktreeMetadataPrune(repoId)
  }
}

export function forgetLocalWorktreeMetadataPruneGate(repoId: string): void {
  observedGenerationByRepo.delete(repoId)
  listingFingerprintByRepo.delete(repoId)
}

export function __resetLocalWorktreeMetadataPruneGateForTests(): void {
  pruneInputsGeneration = 0
  observedGenerationByRepo.clear()
  listingFingerprintByRepo.clear()
}

/** Removing either local or remote ownership can unpin metadata in other repos. */
export function retireLocalWorktreeMetadataPruneStateForRepo(
  repoId: string,
  hostId: string | null
): void {
  if (hostId === null) {
    forgetLocalWorktreeMetadataPruneGate(repoId)
  }
  invalidateLocalWorktreeMetadataPruneInputs()
}
