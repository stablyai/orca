import { isFolderRepo } from '../../../shared/repo-kind'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { createProjectGroup } from '../../../shared/project-groups'
import { createNestedProjectGroupResolver } from '../../project-groups/nested-repo-import'

import type { StoreRuntimeState } from './store-runtime-state'

type LoadedStateAdaptationOperationsRuntime = Pick<StoreRuntimeState, 'loadNeedsSave' | 'state'>

export class LoadedStateAdaptationOperations {
  constructor(private readonly runtime: LoadedStateAdaptationOperationsRuntime) {}

  hydrateFolderWorkspaceDiffComments(): void {
    const stored = this.runtime.state.folderWorkspaceDiffComments
    let relocatedInline = false
    for (const workspace of this.runtime.state.folderWorkspaces ?? []) {
      if (Array.isArray(workspace.diffComments) && workspace.diffComments.length > 0) {
        // Inline notes win after rollback writes; persist relocation even without further edits.
        relocatedInline = true
        continue
      }
      const comments = stored?.[workspace.id]
      // Empty map entries must not erase intact inline notes.
      if (Array.isArray(comments) && comments.length > 0) {
        workspace.diffComments = comments
      }
    }
    if (relocatedInline) {
      this.runtime.loadNeedsSave = true
    }
    // This map is output-only; retaining it would create a stale second source of truth.
    delete this.runtime.state.folderWorkspaceDiffComments
  }

  adaptFlatFolderScanProjectGroups(): boolean {
    // Upgrade legacy flat folder imports into sparse folder scopes.
    const groups = this.runtime.state.projectGroups ?? []
    const repos = this.runtime.state.repos
    if (groups.length === 0 || repos.length === 0) {
      return false
    }

    let changed = false
    let maxOrder = -1
    for (const group of groups) {
      maxOrder = Math.max(maxOrder, group.tabOrder)
    }

    const childGroupIds = new Set(
      groups.flatMap((group) => (group.parentGroupId ? [group.parentGroupId] : []))
    )
    const initialGroupCount = groups.length
    for (let groupIndex = 0; groupIndex < initialGroupCount; groupIndex += 1) {
      const rootGroup = groups[groupIndex]
      if (!rootGroup) {
        continue
      }
      if (
        rootGroup.createdFrom !== 'folder-scan' ||
        !rootGroup.parentPath ||
        rootGroup.parentGroupId ||
        childGroupIds.has(rootGroup.id)
      ) {
        continue
      }
      const rootPath = rootGroup.parentPath
      const repoCandidates = repos.filter(
        (repo) =>
          !isFolderRepo(repo) &&
          repo.projectGroupId === rootGroup.id &&
          isPathInsideOrEqual(rootPath, repo.path)
      )
      if (repoCandidates.length < 2) {
        continue
      }

      const resolver = createNestedProjectGroupResolver({
        parentPath: rootPath,
        groupName: rootGroup.name,
        mode: 'group',
        repoPaths: repoCandidates.map((repo) => repo.path),
        createGroup: (input) => {
          if (!input.parentGroupId) {
            return rootGroup
          }
          maxOrder += 1
          const group = createProjectGroup({
            ...input,
            tabOrder: maxOrder
          })
          groups.push(group)
          changed = true
          return group
        }
      })
      const nextOrderByGroupId = new Map<string, number>()
      for (const repo of repoCandidates) {
        const group = resolver.getGroupForRepo(repo.path)
        if (!group) {
          continue
        }
        if (repo.projectGroupId !== group.id) {
          const nextOrder = nextOrderByGroupId.get(group.id) ?? 0
          nextOrderByGroupId.set(group.id, nextOrder + 1)
          repo.projectGroupId = group.id
          repo.projectGroupOrder = nextOrder
          changed = true
        }
      }
    }
    return changed
  }
}
