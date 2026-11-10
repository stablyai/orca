import {
  appendLineageDiagnosticComment,
  confirmedWorktreeLineageProject,
  getWorkspaceLineagePolicy,
  PROJECT_LINEAGE_CONFLICT_MESSAGE
} from '../../../../shared/workspace-lineage-policy'
import {
  readAllWorktreeMetaForHost,
  worktreeRowTarget
} from '../../../persistence/host-qualified-worktree-meta'
import { splitWorktreeId } from '../../../../shared/worktree/id'
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

/** App picks are manual; an orchestration-picked parent is orchestration's; else the CLI's flag or inferred caller. */
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
    origin:
      input.crossStoreParentInferredFrom === 'orchestration-context' ? 'orchestration' : 'cli',
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
  const target = store ? worktreeRowTarget(store, worktree) : undefined
  const restricted = getWorkspaceLineagePolicy(store?.getSettings?.()) === 'same-project'
  const rootWithDiagnostic = () => {
    if (restricted && store && target && warnings.length) {
      const meta = readAllWorktreeMetaForHost(store, target.hostId)[worktree.id]
      const comment = appendLineageDiagnosticComment(meta?.comment, { kind: 'none', warnings })
      if (comment !== meta?.comment) {
        store.setWorktreeMeta(target, { comment })
      }
    }
    return { lineage: null, workspaceLineage: null, warnings }
  }
  if (restricted && resolution.kind !== 'none') {
    const rows = store && target ? readAllWorktreeMetaForHost(store, target.hostId) : {}
    const catalog = {
      projects: store?.getProjects?.() ?? [],
      projectHostSetups: store?.getProjectHostSetups?.() ?? []
    }
    const childMeta = rows[worktree.id]
    const parent =
      resolution.kind === 'lineage' && resolution.parent.type === 'worktree'
        ? resolution.parent
        : undefined
    const parentMeta = parent ? rows[parent.worktree.id] : undefined
    const childProject = childMeta
      ? confirmedWorktreeLineageProject(catalog, {
          ...childMeta,
          repoId: splitWorktreeId(worktree.id)?.repoId ?? ''
        })
      : undefined
    const parentProject =
      parent && parentMeta
        ? confirmedWorktreeLineageProject(catalog, {
            ...parentMeta,
            repoId: splitWorktreeId(parent.worktree.id)?.repoId ?? ''
          })
        : undefined
    if (
      !childProject ||
      childProject !== parentProject ||
      childMeta?.instanceId !== worktree.instanceId ||
      parentMeta?.instanceId !== parent?.instanceId
    ) {
      warnings.push({
        code: 'LINEAGE_PARENT_CONTEXT_CONFLICT',
        message: `Workspace kept as a root. ${PROJECT_LINEAGE_CONFLICT_MESSAGE}`,
        details: {
          parentWorkspaceKey: resolution.parent.workspaceKey,
          ...(resolution.kind === 'lineage'
            ? {
                taskId: resolution.taskId,
                orchestrationRunId: resolution.orchestrationRunId,
                coordinatorHandle: resolution.coordinatorHandle,
                createdByTerminalHandle: resolution.createdByTerminalHandle
              }
            : { parentInstallationId: resolution.parent.installationId })
        }
      })
      return rootWithDiagnostic()
    }
  }
  if (resolution.kind === 'crossStore') {
    return { lineage, workspaceLineage, ...recordCrossStoreLineage(store, worktree, resolution) }
  }
  if (resolution.kind !== 'lineage') {
    return rootWithDiagnostic()
  }

  const childInstanceId = worktree.instanceId
  const parentInstanceId = resolution.parent.instanceId
  const createdAt = Date.now()
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
    workspaceLineage = store.setWorkspaceLineage(row) ?? null
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
