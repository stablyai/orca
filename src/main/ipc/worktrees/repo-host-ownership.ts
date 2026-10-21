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
  // Why: host-qualified operations must never guess between repo owners; legacy unscoped calls work only for one unique owner.
  const owner = resolveWorktreeRemovalRepoOwner(store, repoId, hostId)
  return owner.kind === 'resolved' ? owner.repo : undefined
}

/**
 * Refuses a repo row whose two host spellings disagree.
 *
 * Everything below picks the filesystem it deletes on from `repo.connectionId`, while the metadata
 * prune, the archive-hook route and the home authority all come from `removalHostId`. A row naming
 * `executionHostId: 'ssh:<target>'` with no `connectionId` therefore lists and deletes a same-named
 * path on THIS machine while the guards vouch for the remote one, and the reverse row does the
 * mirror image (#11163). Neither spelling is evidence about the other, so refuse instead of picking
 * a winner: the worktree is left in place, which is the recoverable outcome
 * (docs/reference/ssh-execution-boundary.md).
 */
export function assertRemovalHostMatchesRepoRow(
  repo: Repo,
  repoId: string,
  removalHostId: ExecutionHostId
): void {
  const repoRowHostId = getRepoExecutionHostId({
    connectionId: repo.connectionId,
    executionHostId: null
  })
  // `repoRowHostId` is built from `connectionId`, so it is always `local` or an `ssh:` id and its
  // name is never `null`. An unroutable `removalHostId` can therefore only ever be the left operand,
  // and `null` matches no name — which is how `runtime:<env>` is refused here.
  if (removalHostName(removalHostId) !== removalHostName(repoRowHostId)) {
    throw new Error(
      `Refusing to delete worktree: repo ${repoId} names execution host ${removalHostId}, but its checkout is only reachable as ${repoRowHostId}.`
    )
  }
}

/**
 * The machine a host id names, or `null` for one this path cannot delete on.
 *
 * Compared after decoding rather than as stored text: `ssh:my target` and `ssh:my%20target` are the
 * same host, and refusing a removal over the spelling of a percent-escape would be a false alarm on
 * a row that is perfectly consistent. `runtime:<env>` and an unparseable id name no machine this
 * path can delete on, so they answer `null` and the caller refuses them outright.
 */
function removalHostName(hostId: ExecutionHostId): string | null {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind === 'local') {
    return 'local'
  }
  return parsed?.kind === 'ssh' ? `ssh:${parsed.targetId}` : null
}
