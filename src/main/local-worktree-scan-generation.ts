const generationByRepoId = new Map<string, number>()
let generationSequence = 0

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
}

export function isLocalWorktreeScanGenerationCurrent(repoId: string, generation: number): boolean {
  return getLocalWorktreeScanGeneration(repoId) === generation
}

export function resetLocalWorktreeScanGenerationsForTests(): void {
  generationSequence += 1
  generationByRepoId.clear()
}
