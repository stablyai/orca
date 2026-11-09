import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'

import type { Worktree } from '../../../../shared/worktree/types'
import type {
  CrossStoreInferredSource,
  CrossStoreParentRef,
  CrossStoreWorkspaceLineage,
  WorktreeLineage,
  WorktreeLineageWarning,
  WorkspaceLineage
} from '../../../../shared/worktree/lineage-types'
import { type WorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { worktreeRowTarget } from '../../../persistence/host-qualified-worktree-meta'

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
  | CrossStoreLineageResolution
  | { kind: 'none'; warnings: WorktreeLineageWarning[] }

/** A parent in another Orca store; saved only in crossStoreLineageByChildKey. */
export type CrossStoreLineageResolution = {
  kind: 'crossStore'
  parent: CrossStoreParentRef
  origin: WorktreeLineage['origin']
  capture: WorktreeLineage['capture']
}

/** A parent picked in the app (composer or menu), never the CLI's flag. */
export function crossStoreManualLineage(parent: CrossStoreParentRef): CrossStoreLineageResolution {
  return {
    kind: 'crossStore',
    parent,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' }
  }
}

/** App picks are manual; otherwise the CLI's --parent-worktree, or the caller workspace it inferred. */
export function crossStoreCreateLineage(input: {
  crossStoreParent: CrossStoreParentRef
  parentWorkspaceOrigin?: 'manual'
  crossStoreParentInferredFrom?: CrossStoreInferredSource
}): CrossStoreLineageResolution {
  if (input.parentWorkspaceOrigin === 'manual') {
    return crossStoreManualLineage(input.crossStoreParent)
  }
  return {
    kind: 'crossStore',
    parent: input.crossStoreParent,
    origin: 'cli',
    capture: input.crossStoreParentInferredFrom
      ? { source: input.crossStoreParentInferredFrom, confidence: 'inferred' }
      : { source: 'explicit-cli-flag', confidence: 'explicit' }
  }
}

export function recordCreatedWorktreeLineage(
  store: RuntimeStore | null,
  worktree: Pick<Worktree, 'id' | 'instanceId' | 'hostId'>,
  resolution: WorktreeLineageRecordingResolution
): {
  lineage: WorktreeLineage | null
  workspaceLineage: WorkspaceLineage | null
  crossStoreLineage?: CrossStoreWorkspaceLineage | null
  warnings: WorktreeLineageWarning[]
} {
  const warnings = resolution.kind === 'none' ? [...resolution.warnings] : []
  let lineage: WorktreeLineage | null = null
  let workspaceLineage: WorkspaceLineage | null = null
  if (resolution.kind === 'crossStore') {
    return { lineage, workspaceLineage, ...recordCrossStoreLineage(store, worktree, resolution) }
  }
  if (resolution.kind !== 'lineage') {
    return { lineage, workspaceLineage, warnings }
  }

  const childInstanceId = worktree.instanceId
  const parentInstanceId = resolution.parent.instanceId
  const createdAt = Date.now()
  const target = store ? worktreeRowTarget(store, worktree) : undefined
  if (
    resolution.parent.type === 'worktree' &&
    childInstanceId &&
    parentInstanceId &&
    target &&
    store?.setWorktreeLineage
  ) {
    lineage =
      store.setWorktreeLineage(target, {
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
        ...(resolution.coordinatorHandle
          ? { coordinatorHandle: resolution.coordinatorHandle }
          : {}),
        ...(resolution.createdByTerminalHandle
          ? { createdByTerminalHandle: resolution.createdByTerminalHandle }
          : {}),
        createdAt
      }) ?? null
    if (!lineage) {
      // The id's lineage belongs to a same-id twin on another host; its workspace row too.
      warnings.push({
        code: 'LINEAGE_PARENT_CONTEXT_CONFLICT',
        message:
          'Worktree created, but its lineage is held by a workspace at the same path on another host.'
      })
      return { lineage, workspaceLineage, warnings }
    }
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
  if (!childInstanceId) {
    return { lineage, workspaceLineage, warnings }
  }
  const row: WorkspaceLineage = {
    childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
    childInstanceId,
    parentWorkspaceKey: resolution.parent.workspaceKey,
    parentInstanceId:
      resolution.parent.type === 'folder' ? resolution.parent.folderWorkspace.id : parentInstanceId,
    origin: resolution.origin,
    capture: resolution.capture,
    ...(resolution.taskId ? { taskId: resolution.taskId } : {}),
    ...(resolution.orchestrationRunId ? { orchestrationRunId: resolution.orchestrationRunId } : {}),
    ...(resolution.coordinatorHandle ? { coordinatorHandle: resolution.coordinatorHandle } : {}),
    ...(resolution.createdByTerminalHandle
      ? { createdByTerminalHandle: resolution.createdByTerminalHandle }
      : {}),
    createdAt
  }
  if (resolution.parent.type === 'folder') {
    // Created already: a same-id twin owning the bucket leaves the folder link unsaved, with a warning.
    workspaceLineage = (target && store?.setFolderParentLineage?.(target, row)) ?? null
    if (!workspaceLineage) {
      warnings.push({
        code: 'LINEAGE_PARENT_CONTEXT_CONFLICT',
        message:
          'Worktree created, but its lineage is held by a workspace at the same path on another host.'
      })
    }
  } else if (lineage) {
    // setWorktreeLineage already wrote this row as the link's workspace projection.
    workspaceLineage = row
  } else if (store?.setWorkspaceLineage) {
    workspaceLineage = store.setWorkspaceLineage(row)
  }
  return { lineage, workspaceLineage, warnings }
}

function recordCrossStoreLineage(
  store: RuntimeStore | null,
  worktree: Pick<Worktree, 'id' | 'instanceId' | 'hostId'>,
  resolution: CrossStoreLineageResolution
): { crossStoreLineage: CrossStoreWorkspaceLineage | null; warnings: WorktreeLineageWarning[] } {
  const target = store ? worktreeRowTarget(store, worktree) : undefined
  const crossStoreLineage =
    worktree.instanceId && target
      ? (store?.setCrossStoreWorkspaceLineage?.(
          {
            childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
            childInstanceId: worktree.instanceId,
            parent: resolution.parent,
            origin: resolution.origin,
            capture: resolution.capture,
            createdAt: Date.now()
          },
          target.hostId
        ) ?? null)
      : null
  return {
    crossStoreLineage,
    warnings: crossStoreLineage
      ? []
      : [
          {
            code: 'LINEAGE_PARENT_CONTEXT_MISSING',
            message:
              'Worktree created, but Orca could not record its parent on another machine for this workspace.'
          }
        ]
  }
}
