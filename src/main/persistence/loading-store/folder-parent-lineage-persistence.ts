import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import { ownsRawIdBucket } from './metadata-lineage-operations'
import type { StoreRuntimeState } from './store-runtime-state'
import { type WriteSchedulingOperations, scheduleSave } from './write-scheduling'

type FolderParentLineageRuntime = Pick<StoreRuntimeState, 'state'>

const folderParentLineageContext = Symbol('FolderParentLineagePersistence')
type FolderParentLineageContext = {
  runtime: FolderParentLineageRuntime
  scheduling: WriteSchedulingOperations
}

/** A worktree's folder workspace parent, which lives only in the workspace-keyed map. */
export class FolderParentLineagePersistence {
  readonly [folderParentLineageContext]: FolderParentLineageContext

  constructor(runtime: FolderParentLineageRuntime, scheduling: WriteSchedulingOperations) {
    this[folderParentLineageContext] = { runtime, scheduling }
  }

  /** Replaces the worktree's other parent records; undefined when another host owns its raw-ID bucket. */
  setFolderParentLineage(
    target: HostWorktreeTarget,
    lineage: WorkspaceLineage
  ): WorkspaceLineage | undefined {
    const { state } = this[folderParentLineageContext].runtime
    if (!ownsRawIdBucket(state, target)) {
      return undefined
    }
    delete state.worktreeLineageById[target.id]
    delete state.crossStoreLineageByChildKey?.[worktreeWorkspaceKey(target.id)]
    state.workspaceLineageByChildKey[worktreeWorkspaceKey(target.id)] = lineage
    scheduleSave(this[folderParentLineageContext].scheduling)
    return lineage
  }
}

/**
 * Before hydrate checked folder parents, a worktree created under a folder could also get an
 * inferred worktree parent. Keep the explicit folder parent; leave every other pairing as saved.
 */
export function dropInferredParentsOverFolderParents(
  worktreeLineageById: Record<string, WorktreeLineage>,
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>,
  worktreeIds: Iterable<string> = Object.keys(worktreeLineageById)
): void {
  for (const worktreeId of worktreeIds) {
    const lineage = worktreeLineageById[worktreeId]
    const row = workspaceLineageByChildKey[worktreeWorkspaceKey(worktreeId)]
    // Saved worktree rows load unvalidated; a malformed one must not fail the whole load.
    if (
      row?.capture.confidence === 'explicit' &&
      parseWorkspaceKey(row.parentWorkspaceKey)?.type === 'folder' &&
      lineage?.capture?.confidence === 'inferred'
    ) {
      delete worktreeLineageById[worktreeId]
    }
  }
}
