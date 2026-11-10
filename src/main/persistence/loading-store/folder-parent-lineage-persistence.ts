import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { WORKSPACE_LINEAGE_DOMAINS } from '../profile-save-domains'
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
    scheduleSave(this[folderParentLineageContext].scheduling, WORKSPACE_LINEAGE_DOMAINS)
    return lineage
  }
}

/**
 * Before hydrate checked folder parents, it could save an inferred worktree parent beside a
 * worktree's folder parent. The folder wins when it was chosen explicitly or the worktree parent
 * has hydrate's stamp; every other pairing stays as saved.
 */
export function folderParentDefeatsInferredParent(
  legacy: WorktreeLineage | undefined,
  row: WorkspaceLineage | undefined
): boolean {
  // Saved worktree rows load unvalidated; a malformed one must not fail the whole load.
  if (
    !row ||
    parseWorkspaceKey(row.parentWorkspaceKey)?.type !== 'folder' ||
    legacy?.capture?.confidence !== 'inferred'
  ) {
    return false
  }
  return (
    row.capture?.confidence === 'explicit' ||
    (legacy.origin === 'orchestration' && legacy.capture.source === 'orchestration-context')
  )
}

export function dropInferredParentsOverFolderParents(
  worktreeLineageById: Record<string, WorktreeLineage>,
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
): void {
  for (const worktreeId of Object.keys(worktreeLineageById)) {
    if (
      folderParentDefeatsInferredParent(
        worktreeLineageById[worktreeId],
        workspaceLineageByChildKey[worktreeWorkspaceKey(worktreeId)]
      )
    ) {
      delete worktreeLineageById[worktreeId]
    }
  }
}
