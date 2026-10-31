import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { loadWorktreeRemovalRecords } from '../worktree-background-removal'

/** Retain failed deletions only while this host has the local repo copy; an SSH copy under the same ID cannot show its deletion row. */
export function loadWorktreeRemovalRecordsForStore(store: {
  getProfileStorageDirectory: () => string
  getRepos: () => readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
}): Promise<void> {
  return loadWorktreeRemovalRecords(store.getProfileStorageDirectory(), (repoId) =>
    store
      .getRepos()
      .some(
        (repo) => repo.id === repoId && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      )
  )
}
