import { randomUUID } from 'node:crypto'
import type { Repo } from '../shared/repo-types'

type RepoIdClaimStore = {
  claimRemovedRepoId?: (
    target: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>
  ) => string | null
}

/** Why: a re-registered folder keeps its old id; create and clone make new folders and mint fresh. */
export function resolveRepoIdForExistingFolder(
  store: RepoIdClaimStore,
  target: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>
): string {
  return store.claimRemovedRepoId?.(target) ?? randomUUID()
}
