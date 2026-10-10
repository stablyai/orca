import type { FolderWorkspace, WorkspaceKey } from '../../shared/folder-workspace-types'
import type { Worktree } from '../../shared/worktree/types'
import type {
  WorktreeLineage,
  WorktreeLineageWarning,
  WorkspaceLineage
} from '../../shared/worktree/lineage-types'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type { RuntimeStore } from './runtime-store-contract'

type LineageParent =
  | {
      type: 'worktree'
      workspaceKey: WorkspaceKey
      worktree: Pick<Worktree, 'id'>
      instanceId: string | null
    }
  | {
      type: 'folder'
      workspaceKey: WorkspaceKey
      folderWorkspace: FolderWorkspace
      instanceId: string | null
    }

export type WorktreeLineageRecordingResolution =
  | {
      kind: 'lineage'
      parent: LineageParent
      origin: WorktreeLineage['origin']
      capture: WorktreeLineage['capture']
      orchestrationRunId?: string
      taskId?: string
      coordinatorHandle?: string
      createdByTerminalHandle?: string
    }
  | { kind: 'none'; warnings: WorktreeLineageWarning[] }

export function recordCreatedWorktreeLineage(
  store: RuntimeStore | null,
  worktree: Pick<Worktree, 'id' | 'instanceId'>,
  resolution: WorktreeLineageRecordingResolution
): {
  lineage: WorktreeLineage | null
  workspaceLineage: WorkspaceLineage | null
  warnings: WorktreeLineageWarning[]
} {
  const warnings = resolution.kind === 'none' ? [...resolution.warnings] : []
  let lineage: WorktreeLineage | null = null
  let workspaceLineage: WorkspaceLineage | null = null
  if (resolution.kind !== 'lineage') {
    return { lineage, workspaceLineage, warnings }
  }

  const childInstanceId = worktree.instanceId
  const parentInstanceId = resolution.parent.instanceId
  const createdAt = Date.now()
  if (
    resolution.parent.type === 'worktree' &&
    childInstanceId &&
    parentInstanceId &&
    store?.setWorktreeLineage
  ) {
    lineage = store.setWorktreeLineage(worktree.id, {
      worktreeId: worktree.id,
      worktreeInstanceId: childInstanceId,
      parentWorktreeId: resolution.parent.worktree.id,
      parentWorktreeInstanceId: parentInstanceId,
      origin: resolution.origin,
      capture: resolution.capture,
      ...(resolution.orchestrationRunId
        ? { orchestrationRunId: resolution.orchestrationRunId }
        : {}),
      ...(resolution.taskId ? { taskId: resolution.taskId } : {}),
      ...(resolution.coordinatorHandle ? { coordinatorHandle: resolution.coordinatorHandle } : {}),
      ...(resolution.createdByTerminalHandle
        ? { createdByTerminalHandle: resolution.createdByTerminalHandle }
        : {}),
      createdAt
    })
  } else if (resolution.parent.type === 'worktree') {
    warnings.push({
      code: 'LINEAGE_PARENT_CONTEXT_MISSING',
      message:
        'Worktree created, but Orca could not record lineage because instance identity was unavailable.',
      details: {
        childHasInstanceId: Boolean(childInstanceId),
        parentHasInstanceId: Boolean(parentInstanceId),
        storeSupportsLineage: Boolean(store?.setWorktreeLineage)
      }
    })
  }
  if (childInstanceId && store?.setWorkspaceLineage) {
    workspaceLineage = store.setWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
      childInstanceId,
      parentWorkspaceKey: resolution.parent.workspaceKey,
      parentInstanceId,
      origin: resolution.origin,
      capture: resolution.capture,
      ...(resolution.taskId ? { taskId: resolution.taskId } : {}),
      ...(resolution.orchestrationRunId
        ? { orchestrationRunId: resolution.orchestrationRunId }
        : {}),
      ...(resolution.coordinatorHandle ? { coordinatorHandle: resolution.coordinatorHandle } : {}),
      ...(resolution.createdByTerminalHandle
        ? { createdByTerminalHandle: resolution.createdByTerminalHandle }
        : {}),
      createdAt
    })
  }
  return { lineage, workspaceLineage, warnings }
}
