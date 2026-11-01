import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { Store } from '../../persistence/loading-store/store'
import { resolveWorktreeRemovalRepoOwner } from '../../worktree-removal-repo-owner'

export function resolveRepoForExecutionHost(
  store: Store,
  repoId: string,
  hostId?: ExecutionHostId
): Repo | undefined {
  // Legacy unscoped calls require one unique owner; host-qualified calls must never guess.
  const owner = resolveWorktreeRemovalRepoOwner(store, repoId, hostId)
  return owner.kind === 'resolved' ? owner.repo : undefined
}

/** Reject mismatched filesystem/guard ownership before a remote path could be deleted on this client (#11163). */
export function assertRemovalHostMatchesRepoRow(
  repo: Repo,
  repoId: string,
  removalHostId: ExecutionHostId
): void {
  const repoRowHostId = getRepoExecutionHostId({
    connectionId: repo.connectionId,
    executionHostId: null
  })
  // The repo row always names local/SSH; null for runtime or malformed removal hosts therefore refuses them.
  if (removalHostName(removalHostId) !== removalHostName(repoRowHostId)) {
    throw new Error(
      `Refusing to delete worktree: repo ${repoId} names execution host ${removalHostId}, but its checkout is only reachable as ${repoRowHostId}.`
    )
  }
}

/** Decode equivalent SSH spellings; runtime and malformed IDs name no host this removal path can serve. */
function removalHostName(hostId: ExecutionHostId): string | null {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind === 'local') {
    return 'local'
  }
  return parsed?.kind === 'ssh' ? `ssh:${parsed.targetId}` : null
}
