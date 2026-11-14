import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { PersistedState } from '../../../../shared/persisted-state-types'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import { toWorkspaceLineageRow } from '../../../../shared/worktree/lineage/worktree-lineage-workspace-row'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey,
  type WorkspaceKey
} from '../../../../shared/workspace-scope'
import { folderParentDefeatsInferredParent } from '../../loading-store/workspace-lineage/folder-parent-lineage-persistence'
import { ownsRawIdBucket } from '../../loading-store/workspace-lineage/metadata-lineage-operations'

/** One imported child's parent records; `legacy: null` deletes a destination worktree row. */
export type PreparedChildLineage = {
  childKey: WorkspaceKey
  worktreeId?: string
  legacy?: WorktreeLineage | null
  workspace?: WorkspaceLineage
}

type IncomingLineage = {
  worktreeLineage: readonly { key: string; value: WorktreeLineage }[]
  workspaceLineage: readonly { key: string; value: WorkspaceLineage }[]
}

function conflict(childKey: string): Error {
  return new Error(`orcad_migration_dormant_id_conflict:lineage_parent:${childKey}`)
}

const sameStamp = (left: string | null | undefined, right: string): boolean =>
  left == null || left === right

/** Both rows name the same worktree parent with agreeing identity stamps. */
function sameParent(legacy: WorktreeLineage, row: WorkspaceLineage): boolean {
  return (
    row.parentWorkspaceKey === worktreeWorkspaceKey(legacy.parentWorktreeId) &&
    sameStamp(row.childInstanceId, legacy.worktreeInstanceId) &&
    sameStamp(row.parentInstanceId, legacy.parentWorktreeInstanceId)
  )
}

/**
 * Settles one parent for each child the import touches, before anything is written. Only the
 * load repair's folder-over-inferred rule picks a winner; any other disagreement refuses the
 * whole import, since an import is not a reparent.
 */
export function reconcileImportedLineage(
  state: PersistedState,
  incoming: IncomingLineage
): PreparedChildLineage[] {
  const incomingLegacy = new Map(incoming.worktreeLineage.map((row) => [row.key, row.value]))
  const incomingRows = new Map<string, WorkspaceLineage>(
    incoming.workspaceLineage.map((row) => [row.key, row.value])
  )
  const childKeys = new Set<WorkspaceKey>([
    ...incoming.worktreeLineage.map((row) => worktreeWorkspaceKey(row.key)),
    ...incoming.workspaceLineage.flatMap((row) => {
      const parsed = parseWorkspaceKey(row.key)
      if (!parsed) {
        return []
      }
      return [
        parsed.type === 'worktree'
          ? worktreeWorkspaceKey(parsed.worktreeId)
          : folderWorkspaceKey(parsed.folderWorkspaceId)
      ]
    })
  ])
  return [...childKeys].map((childKey) => {
    const parsed = parseWorkspaceKey(childKey)
    const worktreeId = parsed?.type === 'worktree' ? parsed.worktreeId : undefined
    if (state.crossStoreLineageByChildKey?.[childKey]) {
      throw conflict(childKey)
    }
    if (
      worktreeId &&
      !ownsRawIdBucket(
        state,
        hostWorktreeTarget({ id: worktreeId, hostId: LOCAL_EXECUTION_HOST_ID })
      )
    ) {
      throw conflict(childKey)
    }
    const savedLegacy = worktreeId ? state.worktreeLineageById[worktreeId] : undefined
    const savedRow = state.workspaceLineageByChildKey[childKey]
    let legacy = savedLegacy ?? (worktreeId ? incomingLegacy.get(worktreeId) : undefined)
    const row = savedRow ?? incomingRows.get(childKey)
    if (folderParentDefeatsInferredParent(legacy, row)) {
      legacy = undefined
    }
    if (legacy && row && !sameParent(legacy, row)) {
      throw conflict(childKey)
    }
    return {
      childKey,
      ...(worktreeId ? { worktreeId } : {}),
      ...(savedLegacy && !legacy ? { legacy: null } : {}),
      ...(legacy && !savedLegacy ? { legacy } : {}),
      ...(row && !savedRow ? { workspace: row } : {}),
      ...(!row && legacy ? { workspace: toWorkspaceLineageRow(legacy) } : {})
    }
  })
}

export function applyImportedLineage(
  prepared: readonly PreparedChildLineage[],
  state: PersistedState
): void {
  for (const child of prepared) {
    if (child.worktreeId && child.legacy === null) {
      delete state.worktreeLineageById[child.worktreeId]
    } else if (child.worktreeId && child.legacy) {
      state.worktreeLineageById[child.worktreeId] = child.legacy
    }
    if (child.workspace) {
      state.workspaceLineageByChildKey[child.childKey] = child.workspace
    }
  }
}
