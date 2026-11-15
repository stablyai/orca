import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import { worktreeWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

export type AdoptionLineageSnapshot = {
  legacy: Record<string, WorktreeLineage>
  workspace: Record<string, WorkspaceLineage>
  cross: Record<string, unknown>
}

export function validateAdoptionLineage(
  records: AdoptionLineageSnapshot,
  child: { id: string; instanceId?: string },
  parentKey: string,
  parentInstance: string,
  fail: (code: 'ownership_conflict' | 'parent_conflict') => never
): void {
  const key = worktreeWorkspaceKey(child.id)
  const legacy = records.legacy[child.id],
    workspace = records.workspace[key]
  if (
    Object.hasOwn(records.cross, key) ||
    legacy?.taskId ||
    workspace?.taskId ||
    (Object.hasOwn(records.legacy, child.id) && !legacy) ||
    (Object.hasOwn(records.workspace, key) && !workspace)
  ) {
    fail('ownership_conflict')
  }
  if (
    legacy &&
    workspace &&
    (worktreeWorkspaceKey(legacy.parentWorktreeId) !== workspace.parentWorkspaceKey ||
      legacy.worktreeInstanceId !== workspace.childInstanceId ||
      legacy.parentWorktreeInstanceId !== workspace.parentInstanceId)
  ) {
    fail('ownership_conflict')
  }
  if (
    (legacy && legacy.worktreeInstanceId !== child.instanceId) ||
    (workspace && workspace.childInstanceId !== child.instanceId)
  ) {
    fail('ownership_conflict')
  }
  if (
    (legacy && worktreeWorkspaceKey(legacy.parentWorktreeId) !== parentKey) ||
    (workspace && workspace.parentWorkspaceKey !== parentKey)
  ) {
    fail('parent_conflict')
  }
  if (
    (legacy && legacy.parentWorktreeInstanceId !== parentInstance) ||
    (workspace && workspace.parentInstanceId !== parentInstance)
  ) {
    fail('ownership_conflict')
  }
}
