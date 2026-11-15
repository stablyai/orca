import { validateAdoptionLineage, type AdoptionLineageSnapshot } from './adopt-lineage-guard'
import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { resolveFolderWorkspaceHostId } from '../../../../shared/folder-workspaces/folder-workspace-host-id'
import {
  mergeExternalWorktreeInboxPaths,
  isExplicitlyImportedExternalWorktreePath
} from '../../../../shared/worktree/visibility/external-worktree-inbox'
import { workspacePrCopy } from '../../../../shared/orchestration/workspace-pr-copy'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { worktreeWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { ResolvedWorktree } from '../catalog/runtime-worktree-path-identity'
import type { ResolvedWorkspaceParent } from './runtime-worktree-lineage-resolution'

export function adoptExistingWorktree(
  store: RuntimeStore,
  child: ResolvedWorktree,
  parent: ResolvedWorkspaceParent,
  validateParent?: () => void,
  beforeResolution?: AdoptionLineageSnapshot
) {
  const fail = (
    code:
      | 'not_a_project_worktree'
      | 'main_checkout'
      | 'parent_unavailable'
      | 'parent_cycle'
      | 'ownership_conflict'
      | 'parent_conflict'
      | 'adopt_failed'
  ): never => {
    const error = new Error(workspacePrCopy[code](child.path))
    Object.assign(error, { code })
    throw error
  }
  const host = child.hostId
  const repos = store
    .getRepos()
    .filter((repo) => repo.id === child.repoId && getRepoExecutionHostId(repo) === host)
  if (!host || repos.length !== 1) {
    fail('parent_unavailable')
  }
  const repo = repos[0]!
  if (
    normalizeRuntimePathForComparison(child.path) === normalizeRuntimePathForComparison(repo.path)
  ) {
    fail('main_checkout')
  }
  const meta = (id: string) => store.getWorktreeMetaForHost?.(id, host!, { migrate: false })
  if (!child.instanceId || meta(child.id)?.instanceId !== child.instanceId) {
    fail('parent_unavailable')
  }
  const key = worktreeWorkspaceKey(child.id)
  const legacy = store.getAllWorktreeLineage?.(),
    workspace = store.getAllWorkspaceLineage?.(),
    cross = store.getRawCrossStoreWorkspaceLineage?.() ?? store.getAllCrossStoreWorkspaceLineage?.()
  if (!legacy || !workspace || !cross) {
    fail('parent_unavailable')
  }
  const oldLegacy = legacy![child.id],
    oldWorkspace = workspace![key],
    oldCross = cross![key]
  const parentKey = parent.workspaceKey
  const parentHost =
    parent.type === 'worktree'
      ? parent.worktree.hostId
      : resolveFolderWorkspaceHostId(parent.folderWorkspace, store.getProjectGroups?.() ?? [])
  if (parentHost !== host) {
    fail('parent_unavailable')
  }
  if (
    parent.type === 'folder' &&
    !(store.getFolderWorkspaces?.() ?? []).some(
      (folder) =>
        folder.id === parent.folderWorkspace.id &&
        !folder.isArchived &&
        resolveFolderWorkspaceHostId(folder, store.getProjectGroups?.() ?? []) === host
    )
  ) {
    fail('parent_unavailable')
  }
  if (
    parent.type === 'worktree' &&
    store
      .getRepos()
      .filter((row) => row.id === parent.worktree.repoId && getRepoExecutionHostId(row) === host)
      .length !== 1
  ) {
    fail('parent_unavailable')
  }
  const parentInstance = parent.type === 'folder' ? parent.folderWorkspace.id : parent.instanceId
  if (!parentInstance) {
    fail('parent_unavailable')
  }
  if (parent.type === 'worktree' && meta(parent.worktree.id)?.instanceId !== parent.instanceId) {
    fail('parent_unavailable')
  }
  for (const records of [
    beforeResolution,
    { legacy: legacy!, workspace: workspace!, cross: cross! }
  ]) {
    if (records) {
      validateAdoptionLineage(records, child, parentKey, parentInstance!, fail)
    }
  }
  // Validate the canonical chain too: the controller's legacy walk cannot see folder-only records.
  const canonical: Record<string, WorkspaceLineage | undefined> = workspace!
  const visited = new Set<string>()
  let cursor: string | undefined = parentKey
  while (cursor) {
    if (cursor === key || visited.has(cursor)) {
      fail('parent_cycle')
    }
    visited.add(cursor)
    cursor = canonical[cursor]?.parentWorkspaceKey
  }
  try {
    validateParent?.()
  } catch {
    fail('parent_cycle')
  }
  const parentName =
    parent.type === 'folder'
      ? parent.folderWorkspace.name
      : parent.worktree.displayName || parent.worktree.branch
  const visible = isExplicitlyImportedExternalWorktreePath(child.path, repo)
  const linked =
    parent.type === 'folder'
      ? oldWorkspace?.parentInstanceId === parentInstance
      : oldLegacy?.parentWorktreeInstanceId === parentInstance
  if (visible && linked) {
    return {
      worktreeId: child.id,
      parentWorkspaceKey: parentKey,
      status: 'already_adopted' as const,
      message: workspacePrCopy.already(child.path, parentName)
    }
  }
  const imported = repo.importedExternalWorktreePaths
  try {
    if (!linked) {
      const common = {
        origin: 'cli' as const,
        capture: { source: 'explicit-cli-flag' as const, confidence: 'explicit' as const },
        createdAt: Date.now()
      }
      if (parent.type === 'worktree') {
        if (
          !store.setWorktreeLineage?.(hostWorktreeTarget({ id: child.id, hostId: host! }), {
            ...common,
            worktreeId: child.id,
            worktreeInstanceId: child.instanceId!,
            parentWorktreeId: parent.worktree.id,
            parentWorktreeInstanceId: parentInstance!
          })
        ) {
          fail('adopt_failed')
        }
      } else if (
        !store.setFolderParentLineage?.(hostWorktreeTarget({ id: child.id, hostId: host! }), {
          ...common,
          childWorkspaceKey: key,
          childInstanceId: child.instanceId!,
          parentWorkspaceKey: parentKey,
          parentInstanceId: parentInstance
        })
      ) {
        fail('adopt_failed')
      }
    }
    if (
      !visible &&
      !store.updateRepo(repo, {
        importedExternalWorktreePaths: mergeExternalWorktreeInboxPaths(imported, [child.path])
      })
    ) {
      fail('adopt_failed')
    }
  } catch {
    if (oldLegacy) {
      legacy![child.id] = oldLegacy
    } else {
      delete legacy![child.id]
    }
    if (oldWorkspace) {
      workspace![key] = oldWorkspace
    } else {
      delete workspace![key]
    }
    if (oldCross) {
      cross![key] = oldCross
    } else {
      delete cross![key]
    }
    store.updateRepo(repo, { importedExternalWorktreePaths: imported })
    fail('adopt_failed')
  }
  return {
    worktreeId: child.id,
    parentWorkspaceKey: parentKey,
    status: 'adopted' as const,
    message: workspacePrCopy.adopted(child.path, parentName)
  }
}
