import { randomUUID } from 'node:crypto'
import type { WorktreeCatalogVersion } from '../shared/worktree/catalog-version'

const generationByRepoId = new Map<string, number>()
let generationSequence = 0
let mutationRevision = 0
// A new epoch lets clients distinguish a host restart from older catalog publications.
const LOCAL_WORKTREE_CATALOG_EPOCH = randomUUID()

export function localWorktreeCatalogVersionAt(generation: number): WorktreeCatalogVersion {
  return { epoch: LOCAL_WORKTREE_CATALOG_EPOCH, sequence: generation }
}

export function getLocalWorktreeCatalogVersion(repoId: string): WorktreeCatalogVersion {
  return localWorktreeCatalogVersionAt(getLocalWorktreeScanGeneration(repoId))
}

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

export function forgetLocalWorktreeScanGeneration(repoId: string): void {
  generationByRepoId.delete(repoId)
}

export function retireLocalWorktreeScanGeneration(repoId: string): void {
  bumpLocalWorktreeScanGeneration(repoId)
  forgetLocalWorktreeScanGeneration(repoId)
}

/** Same-process mutation counter; unlike generationSequence, reads cannot advance it. */
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

export function _getLocalWorktreeScanGenerationCacheSize(): number {
  return generationByRepoId.size
}
