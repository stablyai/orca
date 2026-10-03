import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { DelegatedWorktreeEdge } from '../../shared/worktree/delegated-worktree-edge'
import type { DelegatedWorktreePlacementRow } from './orchestration/db/federation/federated-dispatch-store'

/** Enough for any realistic sidebar; the renderer drops edges whose rows it cannot see anyway. */
const MAX_DELEGATED_EDGES = 500

/** Only the placement query, so a test — and an older db without it — needs no stand-in for the rest. */
type DelegatedWorktreePlacementSource = {
  listDelegatedWorktreePlacements?: (limit: number) => DelegatedWorktreePlacementRow[]
}

type DelegatedWorktreeEdgeDependencies = {
  getDb(): DelegatedWorktreePlacementSource | null
  /** Worktree the coordinator terminal runs in, by handle. */
  getWorktreeId(handle: string): string | null
  /** Handles are minted per process; after a restart only the pane identity still names the terminal. */
  getHandleForPaneKey(paneKey: string): string | null
}

/**
 * What this runtime knows about its coordinated placements right now.
 *
 * `known: true` with no edges is a real answer — this runtime coordinated
 * nothing. A db that is not up yet, or predates the placement query, cannot
 * answer at all, and publishing that as emptiness would wipe live edges from
 * every reader until the db returns.
 */
export type DelegatedWorktreeEdgeProjectionResult =
  | { known: true; edges: DelegatedWorktreeEdge[] }
  | { known: false }

/**
 * The coordinator side of a cross-host delegation, for the sidebar.
 *
 * Only this runtime can build it: the worker host knows nothing about the
 * coordinator's workspace, and the edge would fail the same-repository,
 * same-host rule that git lineage enforces there.
 */
export class RuntimeDelegatedWorktreeEdgeProjection {
  constructor(private readonly deps: DelegatedWorktreeEdgeDependencies) {}

  build(): DelegatedWorktreeEdgeProjectionResult {
    const db = this.deps.getDb()
    if (!db?.listDelegatedWorktreePlacements) {
      return { known: false }
    }
    let placements: DelegatedWorktreePlacementRow[]
    try {
      placements = db.listDelegatedWorktreePlacements(MAX_DELEGATED_EDGES)
    } catch {
      // Why: this runs inside every graph sync; a locked or older db must not fail the sync,
      // and an unanswered query is unknown, not empty.
      return { known: false }
    }
    const edges: DelegatedWorktreeEdge[] = []
    for (const placement of placements) {
      // No bare-id comparison here: ids collide across hosts, and a genuine
      // self-reference is only decidable once both ends are host-qualified,
      // which resolveDelegatedWorktreeNesting already does.
      const parentWorktreeId = this.resolveCoordinatorWorktreeId(placement)
      if (!parentWorktreeId) {
        continue
      }
      edges.push({
        parentWorktreeId,
        childHostId: toRuntimeExecutionHostId(placement.environment_id),
        childWorktreeId: placement.remote_worktree_id,
        dispatchId: placement.dispatch_id
      })
    }
    return { known: true, edges }
  }

  private resolveCoordinatorWorktreeId(placement: {
    creator_handle: string | null
    creator_pane_key: string | null
  }): string | null {
    const byHandle = placement.creator_handle
      ? this.deps.getWorktreeId(placement.creator_handle)
      : null
    if (byHandle) {
      return byHandle
    }
    const handle = placement.creator_pane_key
      ? this.deps.getHandleForPaneKey(placement.creator_pane_key)
      : null
    return handle ? this.deps.getWorktreeId(handle) : null
  }
}
