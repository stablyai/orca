import { randomUUID } from 'node:crypto'
import type { WorktreeCatalogVersion } from '../shared/worktree/catalog-version'

const generationByRepoId = new Map<string, number>()
let generationSequence = 0
let mutationRevision = 0
// Why per process: generations restart with the process, so a client ordering catalog
// publications across a host restart must see the restart as a new catalog, not an older one.
const LOCAL_WORKTREE_CATALOG_EPOCH = randomUUID()

/** The catalog version a scan that began at `generation` describes. */
export function localWorktreeCatalogVersionAt(generation: number): WorktreeCatalogVersion {
  return { epoch: LOCAL_WORKTREE_CATALOG_EPOCH, sequence: generation }
}

/** The repo's current catalog version: what a mutation reply issued now describes. */
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

export function _getLocalWorktreeScanGenerationCacheSize(): number {
  return generationByRepoId.size
}
