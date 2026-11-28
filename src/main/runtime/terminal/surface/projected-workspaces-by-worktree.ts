// Main's projected workspaces by worktree id, built with the projection so a per-workspace read scans no other workspace.

import type { WorkspaceSessionPartitionId } from '../../../../shared/workspace-session/teammate-homes-session-partition'
import type { LoadedWorkspaceLayoutRead } from '../../../../shared/workspace-layout/persistence/workspace-layout-load-types'
import type { WorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-model'

export type ProjectedWorkspace = Pick<LoadedWorkspaceLayoutRead, 'desktopView' | 'facts'> & {
  key: string
  workspace: WorkspaceLayout
}

/** The first workspace for each worktree id that its home partition holds, in partition order. */
export function projectedWorkspacesByWorktree(
  partitions: readonly (LoadedWorkspaceLayoutRead | null)[],
  hostIds: readonly WorkspaceSessionPartitionId[],
  routes: ReadonlyMap<string, WorkspaceSessionPartitionId | null>
): Map<string, ProjectedWorkspace> {
  const indexed = new Map<string, ProjectedWorkspace>()
  partitions.forEach((partition, index) => {
    for (const [key, workspace] of Object.entries(partition?.layout.workspaces ?? {})) {
      if (partition && routes.get(key) === hostIds[index] && !indexed.has(workspace.worktreeId)) {
        const { desktopView, facts } = partition
        indexed.set(workspace.worktreeId, { key, workspace, desktopView, facts })
      }
    }
  })
  return indexed
}
