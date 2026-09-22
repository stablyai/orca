import type { ExecutionHostId } from '../shared/execution-host'

export type WorkspaceSnapshotPruneTarget = {
  worktreeId: string
  executionHostId?: ExecutionHostId
}

export type WorkspaceSnapshotPruneTombstone = WorkspaceSnapshotPruneTarget & {
  prunedAt: number
}

export function workspaceSnapshotPruneKey(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): string {
  return `${executionHostId ?? '*'}\0${worktreeId}`
}

export function workspaceSnapshotPruneTargetKeys(
  targets: readonly WorkspaceSnapshotPruneTarget[]
): Set<string> {
  return new Set(
    targets.map(({ worktreeId, executionHostId }) =>
      workspaceSnapshotPruneKey(worktreeId, executionHostId)
    )
  )
}

export function activeWorkspaceSnapshotPruneKeys(
  tombstones: ReadonlyMap<string, WorkspaceSnapshotPruneTombstone> | undefined,
  scannedAt: number
): Set<string> {
  const keys = new Set<string>()
  for (const [key, entry] of tombstones ?? []) {
    if (entry.prunedAt >= scannedAt) {
      keys.add(key)
    }
  }
  return keys
}

export function registerWorkspaceSnapshotPrunesForFile(
  tombstonesByFile: Map<string, Map<string, WorkspaceSnapshotPruneTombstone>>,
  file: string,
  targets: readonly WorkspaceSnapshotPruneTarget[]
): void {
  const tombstones = tombstonesByFile.get(file) ?? new Map()
  const prunedAt = Date.now()
  for (const { worktreeId, executionHostId } of targets) {
    tombstones.set(workspaceSnapshotPruneKey(worktreeId, executionHostId), {
      worktreeId,
      ...(executionHostId ? { executionHostId } : {}),
      prunedAt
    })
  }
  tombstonesByFile.set(file, tombstones)
}
