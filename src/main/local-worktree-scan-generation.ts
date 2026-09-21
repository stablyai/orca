const generationByRepoId = new Map<string, number>()
let generationSequence = 0
let mutationRevision = 0

export function getLocalWorktreeScanGeneration(repoId: string): number {
  const existing = generationByRepoId.get(repoId)
  if (existing !== undefined) {
    return existing
  }
  const generation = ++generationSequence
  generationByRepoId.set(repoId, generation)
  return generation
}

export function bumpLocalWorktreeScanGeneration(repoId: string): void {
  generationByRepoId.set(repoId, ++generationSequence)
  mutationRevision += 1
}

/**
 * Advances on every event above that can change what a worktree scan would find — repo add,
 * removal, update, and scan-cache invalidation — and on nothing else. A cache that must not answer
 * for repos it never saw compares this in O(1) instead of walking the repo list.
 *
 * Why not `generationSequence`: that also advances when `getLocalWorktreeScanGeneration` mints a key
 * for a repo id nothing has scanned yet, which is a read. Keying a snapshot on it would let a read
 * path discard a snapshot that is still perfectly valid.
 *
 * Ordering-only: the value means nothing outside a same-process comparison.
 */
export function getWorktreeScanMutationRevision(): number {
  return mutationRevision
}

export function isLocalWorktreeScanGenerationCurrent(repoId: string, generation: number): boolean {
  return getLocalWorktreeScanGeneration(repoId) === generation
}

export function resetLocalWorktreeScanGenerationsForTests(): void {
  generationSequence += 1
  mutationRevision += 1
  generationByRepoId.clear()
}
