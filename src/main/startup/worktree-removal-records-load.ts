import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { loadWorktreeRemovalRecords } from '../worktree-background-removal'

/**
 * Loads this host's removal records at startup. A failed delete is kept only while its repo's LOCAL
 * copy is in Orca: only local listings show the row, and an SSH copy under the same id never would.
 */
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
