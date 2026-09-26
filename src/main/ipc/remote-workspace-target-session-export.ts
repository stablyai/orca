import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import { exportRemoteWorkspaceSession } from '../../shared/remote-workspace-session-projection'
import type { RemoteWorkspaceSession } from '../../shared/remote-workspace-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import {
  adoptStrandedHostPartitionSession,
  workspaceIdsNamedByPartition
} from '../../shared/workspace-session-stranded-partition-adoption'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import {
  resolveWorktreeExecutionHost,
  type createRepoRowExecutionHostLookup,
  type WorktreeExecutionHostResolution
} from '../../shared/worktree-execution-host-resolution'

type RepoRowLookup = ReturnType<typeof createRepoRowExecutionHostLookup<Repo>>

/** Which target a workspace session is exported to. */
export type WorktreeTargetResolver = (worktreeId: string, executionHostId?: string) => string | null

/** Who owns a workspace, answered from the repo catalog alone. */
export type WorktreeOwnerResolver = (
  worktreeId: string,
  executionHostId?: string
) => WorktreeExecutionHostResolution<Repo>

/**
 * Resolve each workspace's owner at most once for a whole publish.
 *
 * Why this is shared and not per target: ownership comes from the repo catalog alone — only the
 * final `=== targetId` differs — so exporting to N targets used to repeat the identical resolution
 * N times over every worktree key. `store.getRepos()` also re-hydrates every repo row on each
 * call, and the projection asks this question once per key of `tabsByWorktree`,
 * `activeTabIdByWorktree`, `lastVisitedAtByWorktreeId` and `defaultTerminalTabsAppliedByWorktreeId`
 * — and the publish fallback's catalog attribution asks it again for the same keys.
 */
export function createWorktreeOwnerResolver(repoLookup: RepoRowLookup): WorktreeOwnerResolver {
  const resolved = new Map<string, WorktreeExecutionHostResolution<Repo>>()
  return (worktreeId, executionHostId) => {
    // Host id participates in resolution, so it has to participate in the key. NUL cannot appear
    // in either id, so it is a collision-free separator.
    const key = `${worktreeId}\u0000${executionHostId ?? ''}`
    const cached = resolved.get(key)
    if (cached) {
      return cached
    }
    // Why: this decides which SSH target a workspace session is exported to. The old fallback read
    // `getRepo(id)?.connectionId`, which is host-blind — the same repo id can name rows on several
    // hosts, so a session could be published to a machine that never owned the worktree (#11163).
    // Unresolvable ownership exports to nobody rather than guessing.
    const resolution = resolveWorktreeExecutionHost(repoLookup, {
      repoId: getRepoIdFromWorktreeId(worktreeId),
      hostId: executionHostId ?? null
    })
    resolved.set(key, resolution)
    return resolution
  }
}

export function createWorktreeTargetResolver(
  resolveWorktreeOwner: WorktreeOwnerResolver
): WorktreeTargetResolver {
  return (worktreeId, executionHostId) => {
    const resolution = resolveWorktreeOwner(worktreeId, executionHostId)
    return resolution.kind === 'resolved' ? resolution.connectionId : null
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
 *
 * The contested verdict is computed the same way the renderer's read computes it, over the same two
 * partitions. Main reaching a different one would let it publish rows the renderer never displays.
 */
export function persistedSessionForTarget(
  store: Store,
  targetId: string,
  /** Shared across the whole publish, and with the projection: one resolution per workspace id. */
  resolveWorktreeOwner: WorktreeOwnerResolver
): WorkspaceSessionState {
  const hostId = toSshExecutionHostId(targetId)
  const local = store.getWorkspaceSession()
  const host = store.getWorkspaceSession(hostId)
  return adoptStrandedHostPartitionSession(local, host, {
    ...catalogAttributionForPartition(resolveWorktreeOwner, host, hostId)
  }).session
}

/** The same catalog reading the renderer's boot read applies to this partition: a repo id the
 *  catalog registers on more than one host is contested, and one it positively resolves to a
 *  different host is residue this partition does not own. Main reaching a different verdict would
 *  publish to the host rows the renderer never displays. */
function catalogAttributionForPartition(
  resolveWorktreeOwner: WorktreeOwnerResolver,
  host: WorkspaceSessionState,
  hostId: ExecutionHostId
): { contestedSessionKeys: Set<string>; foreignSessionKeys: Set<string> } {
  const contestedSessionKeys = new Set<string>()
  const foreignSessionKeys = new Set<string>()
  for (const workspaceId of workspaceIdsNamedByPartition(host)) {
    // A folder key names no repo, and `getRepoIdFromWorktreeId` hands back the whole key rather
    // than nothing, so the catalog would be asked about `folder:<uuid>` and answer `unknown`.
    // Right verdict, wasted resolution; skip it by shape instead.
    if (!workspaceId.includes('::')) {
      continue
    }
    const resolution = resolveWorktreeOwner(workspaceId)
    if (resolution.kind === 'unresolved') {
      if (resolution.reason === 'ambiguous') {
        contestedSessionKeys.add(workspaceId)
      }
    } else if (resolution.hostId !== hostId) {
      foreignSessionKeys.add(workspaceId)
    }
  }
  return { contestedSessionKeys, foreignSessionKeys }
}
