import type {
  ProjectGroup,
  ProjectGroupParentMove
} from '../../shared/project/groups/project-group-types'
import type { Repo } from '../../shared/repository/repo-types'
import {
  buildProjectGroupChildIndex,
  collectProjectGroupSubtreeIds,
  type ProjectGroupChildIndex
} from '../../shared/project/groups/project-groups'

type FolderScanGroupReuse = {
  /** Reuses a top-level group for the scanned folder; an edited name renames it once applied. */
  reuseRoot: (
    parentPath: string,
    enteredName: string,
    defaultName: string
  ) => ProjectGroup | undefined
  /** Reuses a group anywhere under the reused root; it moves under parentGroupId once applied. */
  reuseScope: (folderPath: string, parentGroupId: string) => ProjectGroup | undefined
  /** Returns the renamed root, if any. */
  applyChanges: () => ProjectGroup | undefined
}

/** Finds earlier folder-scan groups on one connection by parent path, so a rescan reuses them. */
export function createFolderScanGroupReuse(args: {
  groups: readonly ProjectGroup[]
  repos: readonly Pick<Repo, 'projectGroupId'>[]
  connectionId: string | null
  toPathKey: (path: string) => string
  renameGroup?: (groupId: string, name: string) => ProjectGroup | null | undefined
  reparentGroups?: (moves: readonly ProjectGroupParentMove[]) => void
}): FolderScanGroupReuse {
  const groupsByPathKey = new Map<string, ProjectGroup[]>()
  for (const group of args.groups) {
    if (
      group.createdFrom !== 'folder-scan' ||
      (group.connectionId ?? null) !== args.connectionId ||
      !group.parentPath
    ) {
      continue
    }
    const key = args.toPathKey(group.parentPath)
    const sameKeyGroups = groupsByPathKey.get(key)
    if (sameKeyGroups) {
      sameKeyGroups.push(group)
    } else {
      groupsByPathKey.set(key, [group])
    }
  }
  let childGroupIndex: ProjectGroupChildIndex | undefined
  const getSubtreeIds = (groupId: string): Set<string> => {
    childGroupIndex ??= buildProjectGroupChildIndex(args.groups)
    return collectProjectGroupSubtreeIds(childGroupIndex, groupId)
  }
  const groupIdsWithMembers = new Set(
    args.repos.flatMap((repo) => (repo.projectGroupId ? [repo.projectGroupId] : []))
  )
  const holdsRepos = (group: ProjectGroup): boolean =>
    [...getSubtreeIds(group.id)].some((groupId) => groupIdsWithMembers.has(groupId))
  const find = (
    parentPath: string,
    isCandidate: (group: ProjectGroup) => boolean
  ): ProjectGroup | undefined => {
    const matches = (groupsByPathKey.get(args.toPathKey(parentPath)) ?? []).filter(isCandidate)
    // Earlier duplicate imports moved repos into the newest copy, so prefer a copy that holds repos.
    return matches.length > 1 ? (matches.find(holdsRepos) ?? matches[0]) : matches[0]
  }

  let root: ProjectGroup | undefined
  let rootSubtreeIds: ReadonlySet<string> = new Set()
  let pendingRootName: string | null = null
  const pendingParentMoves: ProjectGroupParentMove[] = []

  return {
    reuseRoot: (parentPath, enteredName, defaultName) => {
      root = find(parentPath, (group) => group.parentGroupId === null)
      if (root) {
        // The dialog prefills the folder name, so only an edited name replaces a rename the user made.
        if (enteredName && enteredName !== defaultName && enteredName !== root.name) {
          pendingRootName = enteredName
        }
        rootSubtreeIds = getSubtreeIds(root.id)
      }
      return root
    },
    reuseScope: (folderPath, parentGroupId) => {
      const rootId = root?.id
      // Folder layout can change between scans, so match anywhere under the root and re-parent.
      const group = find(
        folderPath,
        (candidate) => candidate.id !== rootId && rootSubtreeIds.has(candidate.id)
      )
      if (group && group.parentGroupId !== parentGroupId) {
        pendingParentMoves.push({ groupId: group.id, parentGroupId })
      }
      return group
    },
    // Deferred until the import keeps its groups: rollback deletes created subtrees, so a reused group must not move under one first.
    applyChanges: () => {
      if (pendingParentMoves.length > 0) {
        args.reparentGroups?.(pendingParentMoves.splice(0))
      }
      if (!root || !pendingRootName) {
        return undefined
      }
      const renamed = args.renameGroup?.(root.id, pendingRootName) ?? undefined
      pendingRootName = null
      return renamed
    }
  }
}
