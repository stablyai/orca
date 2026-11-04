import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  localWorktreeRemovalOwners,
  type OwnerResidueStore
} from '../workspaces/removal/worktree-removal-owner-residue'
import { loadWorktreeRemovalRecords } from '../workspaces/removal/worktree-background-removal'

/** Retain failed deletions only while this host has the local repo copy; an SSH copy under the same ID cannot show its deletion row. */
export function loadWorktreeRemovalRecordsForStore(
  store: {
    getProfileStorageDirectory: () => string
  } & OwnerResidueStore
): Promise<void> {
  const localRepoIds = new Set(
    store
      .getRepos()
      .filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
      .map((repo) => repo.id)
  )
  return loadWorktreeRemovalRecords(
    store.getProfileStorageDirectory(),
    (repoId) => localRepoIds.has(repoId),
    (records) => localWorktreeRemovalOwners(store, records)
  )
}
