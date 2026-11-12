import type { ProjectGroupDeleteOptions } from '../../../shared/project-group-removal'
import { getProjectGroupSubtreeIds } from '../../../shared/project-groups'
import { projectGroupHookOwner } from '../../../shared/workspace-hook-owner'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  gateFolderWorkspaceRemovalOnArchiveHook,
  removeFolderWorkspaceRunnerFiles
} from '../../workspaces/removal/folder-workspace-archive-hook'
import type { RuntimeProjectGroupDependencies } from './runtime-project-group-controller'
import { resolveProjectGroupArchiveSnapshot } from './project-group-archive-snapshot'
import { createFolderWorkspaceConnectionResolver } from '../../project-groups/folder-workspace-connection-index'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import {
  worktreeRemovalTargetKey,
  type WorktreeRemovalTarget
} from '../workspaces/removal/worktree-removal-targets'

export async function deleteProjectGroupWithWorkspaceEffects(
  deps: RuntimeProjectGroupDependencies,
  groupId: string,
  options: ProjectGroupDeleteOptions
): Promise<{ deleted: boolean }> {
  const store = deps.getStore()
  if (!store?.deleteProjectGroup) {
    throw new Error('runtime_unavailable')
  }
  const groups = store.getProjectGroups?.() ?? []
  if (!groups.some((group) => group.id === groupId)) {
    return { deleted: false }
  }
  const subtree = getProjectGroupSubtreeIds(groups, groupId)
  const groupsById = new Map(
    groups.filter((group) => subtree.has(group.id)).map((group) => [group.id, group])
  )
  const workspaces = (store.getFolderWorkspaces?.() ?? []).filter((workspace) =>
    subtree.has(workspace.projectGroupId)
  )
  const workspacesByKey = new Map<string, (typeof workspaces)[number]>(
    workspaces.map((workspace) => [folderWorkspaceKey(workspace.id), workspace])
  )
  const resolveConnection = createFolderWorkspaceConnectionResolver(groups, store.getRepos())
  const snapshots = new Map<
    string,
    Awaited<ReturnType<typeof resolveProjectGroupArchiveSnapshot>>
  >()
  const archiveUnproven = new Set<string>()
  for (const workspace of workspaces) {
    const group = groupsById.get(workspace.projectGroupId)
    const owner = group && projectGroupHookOwner(group)
    const worktreeId = folderWorkspaceKey(workspace.id)
    if (owner) {
      if (!snapshots.has(group.id)) {
        try {
          snapshots.set(
            group.id,
            await resolveProjectGroupArchiveSnapshot(owner, group.id, options.archiveDecisions)
          )
        } catch (error) {
          console.warn('[hooks] group archive inspection failed:', error)
          snapshots.set(group.id, null)
        }
      }
      try {
        const overridden = await gateFolderWorkspaceRemovalOnArchiveHook({
          repo: owner,
          worktreeId,
          displayName: workspace.name,
          workspacePath: workspace.folderPath,
          hooks: snapshots.get(group.id) ?? null,
          runArchive: true,
          allowFailure: true,
          runtimeTarget: () => undefined
        })
        if (overridden?.outcome === 'unverifiable') {
          archiveUnproven.add(worktreeId)
        }
      } catch (error) {
        archiveUnproven.add(worktreeId)
        console.warn('[hooks] group workspace archive failed:', error)
      }
    }
  }
  const gates = new Map<
    string,
    Awaited<ReturnType<RuntimeProjectGroupDependencies['acquireFileWatcherRemoval']>>
  >()
  const attemptedRoots = new Set<string>()
  const targets: WorktreeRemovalTarget[] = []
  try {
    for (const workspace of workspaces) {
      const connection = resolveConnection(workspace)
      if (connection.kind === 'ambiguous') {
        continue
      }
      const connectionId = connection.kind === 'ssh' ? connection.connectionId : null
      const key = JSON.stringify([
        connectionId,
        normalizeRuntimePathForComparison(workspace.folderPath)
      ])
      if (!attemptedRoots.has(key)) {
        attemptedRoots.add(key)
        try {
          gates.set(
            key,
            await deps.acquireFileWatcherRemoval(workspace.folderPath, connectionId ?? undefined)
          )
        } catch (error) {
          console.warn('[folder-workspace] watcher removal unavailable:', error)
        }
      }
      targets.push({ worktreeId: folderWorkspaceKey(workspace.id), connectionId })
    }
    let stopped: ReadonlyMap<string, boolean> = new Map()
    try {
      stopped = (await deps.teardownFolderWorkspacesPtys?.(targets)) ?? stopped
    } catch (error) {
      console.warn('[folder-workspace] group teardown incomplete:', error)
    }
    for (const target of targets) {
      if (
        !stopped.get(worktreeRemovalTargetKey(target)) ||
        archiveUnproven.has(target.worktreeId)
      ) {
        continue
      }
      const workspace = workspacesByKey.get(target.worktreeId)
      const group = workspace && groupsById.get(workspace.projectGroupId)
      const owner = group && projectGroupHookOwner(group)
      if (owner) {
        removeFolderWorkspaceRunnerFiles(owner, target.worktreeId)
      }
    }
    // The store owns the existing bulk lineage/session purge and repo ungrouping, once per subtree.
    const deleted = store.deleteProjectGroup(groupId)
    if (deleted) {
      deps.notifyReposChanged()
      for (const workspace of workspaces) {
        deps.emitWorktreeLifecycle({
          kind: 'removed',
          worktreeId: folderWorkspaceKey(workspace.id),
          path: workspace.folderPath,
          ...(workspace.executionHostId ? { hostId: workspace.executionHostId } : {})
        })
      }
    }
    return { deleted }
  } finally {
    for (const gate of gates.values()) {
      try {
        await gate.finish(false)
      } catch (error) {
        console.warn('[folder-workspace] watcher restore failed:', error)
      }
    }
  }
}
