import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import { exportRemoteWorkspaceSession } from '../../shared/remote-workspace-session-projection'
import type { RemoteWorkspaceSession } from '../../shared/remote-workspace-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { adoptStrandedHostPartitionSession } from '../../shared/workspace-session-stranded-partition-adoption'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import {
  resolveWorktreeExecutionHost,
  type createRepoRowExecutionHostLookup
} from '../../shared/worktree-execution-host-resolution'

type RepoRowLookup = ReturnType<typeof createRepoRowExecutionHostLookup<Repo>>

/** Which target a workspace session is exported to. */
export type WorktreeTargetResolver = (worktreeId: string, executionHostId?: string) => string | null

function targetForWorktree(
  repoLookup: RepoRowLookup,
  worktreeId: string,
  executionHostId?: string
): string | null {
  // Why: this decides which SSH target a workspace session is exported to. The old fallback read
  // `getRepo(id)?.connectionId`, which is host-blind — the same repo id can name rows on several
  // hosts, so a session could be published to a machine that never owned the worktree (#11163).
  // Unresolvable ownership exports to nobody rather than guessing.
  const resolution = resolveWorktreeExecutionHost(repoLookup, {
    repoId: getRepoIdFromWorktreeId(worktreeId),
    hostId: executionHostId ?? null
  })
  return resolution.kind === 'resolved' ? resolution.connectionId : null
}

/**
 * Resolve each worktree's owning connection at most once for a whole publish.
 *
 * Why this is shared and not per target: `targetForWorktree` computes a connection id from the
 * repo catalog alone — only the final `=== targetId` differs — so exporting to N targets used to
 * repeat the identical resolution N times over every worktree key. `store.getRepos()` also
 * re-hydrates every repo row on each call, and the projection asks this question once per key of
 * `tabsByWorktree`, `activeTabIdByWorktree`, `lastVisitedAtByWorktreeId` and
 * `defaultTerminalTabsAppliedByWorktreeId`.
 */
export function createWorktreeTargetResolver(repoLookup: RepoRowLookup): WorktreeTargetResolver {
  const resolved = new Map<string, string | null>()
  return (worktreeId, executionHostId) => {
    // Host id participates in resolution, so it has to participate in the key. NUL cannot appear
    // in either id, so it is a collision-free separator.
    const key = `${worktreeId}\u0000${executionHostId ?? ''}`
    const cached = resolved.get(key)
    if (cached !== undefined) {
      return cached
    }
    const connectionId = targetForWorktree(repoLookup, worktreeId, executionHostId)
    resolved.set(key, connectionId)
    return connectionId
  }
}

export function exportSessionForTarget(
  resolveWorktreeTarget: WorktreeTargetResolver,
  targetId: string,
  session: WorkspaceSessionState
): RemoteWorkspaceSession {
  return exportRemoteWorkspaceSession(session, {
    isTargetWorktree: (worktreeId, executionHostId) =>
      resolveWorktreeTarget(worktreeId, executionHostId) === targetId
  })
}

/**
 * The persisted session a publish speaks for when the renderer sent none.
 *
 * Why not `store.getWorkspaceSession()` alone: that reads the 'local' blob, and a target's
 * worktrees live in `ssh:<targetId>` (#12723). Publishing the local half as though it were the
 * whole session uploaded explicit empty tab lists, and `replace-session` turned that absence into
 * deletion on the host (#12721). Resolved per target so one target's rows can never be published
 * under another's key when both partitions hold the same worktree id.
 */
export function persistedSessionForTarget(store: Store, targetId: string): WorkspaceSessionState {
  return adoptStrandedHostPartitionSession(
    store.getWorkspaceSession(),
    store.getWorkspaceSession(toSshExecutionHostId(targetId))
  )
}
