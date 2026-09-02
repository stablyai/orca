const generationByRepoId = new Map<string, number>()
let generationSequence = 0

// Why: repository IDs are process-lifetime inputs, so bound churn from removed and re-added repos.
export const MAX_LOCAL_WORKTREE_SCAN_GENERATIONS = 512

function rememberGeneration(repoId: string, generation: number): void {
  // Map insertion order is the recency order; refresh existing IDs before trimming the oldest.
  generationByRepoId.delete(repoId)
  generationByRepoId.set(repoId, generation)
  while (generationByRepoId.size > MAX_LOCAL_WORKTREE_SCAN_GENERATIONS) {
    const oldest = generationByRepoId.keys().next()
    if (oldest.done) {
      break
    }
    generationByRepoId.delete(oldest.value)
  }
}

export function getLocalWorktreeScanGeneration(repoId: string): number {
  const existing = generationByRepoId.get(repoId)
  if (existing !== undefined) {
    rememberGeneration(repoId, existing)
    return existing
  }
  const generation = ++generationSequence
  rememberGeneration(repoId, generation)
  return generation
}

export function bumpLocalWorktreeScanGeneration(repoId: string): void {
  rememberGeneration(repoId, ++generationSequence)
}

export function isLocalWorktreeScanGenerationCurrent(repoId: string, generation: number): boolean {
  return getLocalWorktreeScanGeneration(repoId) === generation
}

export function resetLocalWorktreeScanGenerationsForTests(): void {
  generationSequence += 1
  generationByRepoId.clear()
}

export function getLocalWorktreeScanGenerationCountForTests(): number {
  return generationByRepoId.size
}
