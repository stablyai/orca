import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { Store } from '../../persistence/loading-store/store'
import { resolveWorktreeRemovalRepoOwner } from '../../worktree-removal-repo-owner'

export function resolveRepoForExecutionHost(
  store: Store,
  repoId: string,
  hostId?: ExecutionHostId
): Repo | undefined {
  // Why: host-qualified operations must never guess between repo owners; legacy unscoped calls work only for one unique owner.
  const owner = resolveWorktreeRemovalRepoOwner(store, repoId, hostId)
  return owner.kind === 'resolved' ? owner.repo : undefined
}
