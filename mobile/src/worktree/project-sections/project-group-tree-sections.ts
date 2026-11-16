import { projectGroupIdFromRepoId } from '../../../../src/shared/folder-workspaces/folder-workspace-worktree'
import type { ProjectGroup } from '../../../../src/shared/project/groups/project-group-types'
import type { ProjectSectionEntry } from '../../../../src/shared/sidebar-list/sections/project-section-grouping'
import { getProjectGroupHeaderKey } from '../../../../src/shared/sidebar-list/sections/group-keys'
import { withRepoSectionDisplayLabels } from '../../../../src/shared/sidebar-list/sections/project-section-order'
import { getFolderBoundGroupingRoots } from '../../../../src/shared/sidebar-list/folders/folder-workspace-occurrences'
import { walkProjectGroupTree } from '../../../../src/shared/sidebar-list/sections/project-group-tree'
import { orderUmbrellaProjectSections } from '../../../../src/shared/sidebar-list/sections/umbrella-subfolder-groups'
import { getWorktreeRowIdentity } from '../row-presentation/worktree-host-row-identity'
import type { ProjectSectionCatalog } from '../workspace-list/workspace-list-sections'
import type {
  Section,
  SectionRepo,
  Worktree,
  WorktreeRowView
} from '../workspace-list/workspace-list-types'

type ProjectEntry = [string, ProjectSectionEntry<Worktree, SectionRepo>]

type TreeSection = Pick<
  Section,
  'isProjectGroup' | 'projectGroupDepth' | 'parentSectionKey' | 'count'
>

// Where a section sits in the tree: the groups that hide it and its rows' indent.
export type GroupTreePlacement = {
  ancestorKeys: readonly string[]
  rowView: Pick<WorktreeRowView, 'projectGroupDepth' | 'inFolderScanGroup'>
}

export type GroupFolderRows = {
  /** Each listed group's folder workspaces and the rows nested under them, as its folder lane. */
  folderRowsByGroupId: Map<string, Worktree[]>
  /** Those folder workspaces, which belong to no project. */
  folders: ReadonlySet<Worktree>
  /** The rows nested under them; they still count in their own projects, only their display moves. */
  bound: ReadonlySet<Worktree>
  /** The row a project section files a row under. */
  groupingRootOf: (row: Worktree) => Worktree
}

// Binds rows to a group's folder lane as the desktop's getSidebarFolderOccurrences does.
export function bindGroupFolderRows(
  rows: readonly Worktree[],
  projectGroups: readonly ProjectGroup[],
  displayRootOf: (row: Worktree) => Worktree,
  childrenByParentIdentity: ReadonlyMap<string, readonly Worktree[]>
): GroupFolderRows {
  const listedGroupIds = new Set(projectGroups.map((group) => group.id))
  const groupIdOf = (row: Worktree) => {
    const groupId =
      row.workspaceKind === 'folder-workspace' ? projectGroupIdFromRepoId(row.repoId) : null
    return groupId && listedGroupIds.has(groupId) ? groupId : null
  }
  const folderRowsByGroupId = new Map<string, Worktree[]>()
  const folders = new Set<Worktree>()
  const bound = new Set<Worktree>()
  for (const row of rows) {
    const groupId = groupIdOf(displayRootOf(row))
    if (!groupId) {
      continue
    }
    ;(groupIdOf(row) ? folders : bound).add(row)
    const laneRows = folderRowsByGroupId.get(groupId)
    if (laneRows) {
      laneRows.push(row)
    } else {
      folderRowsByGroupId.set(groupId, [row])
    }
  }
  const groupingRoots = getFolderBoundGroupingRoots({
    folderIdentities: [...folders].map(getWorktreeRowIdentity),
    childrenByParentIdentity,
    identityOf: getWorktreeRowIdentity,
    listed: new Set(rows),
    bound
  })
  return {
    folderRowsByGroupId,
    folders,
    bound,
    groupingRootOf: (row) => groupingRoots.get(getWorktreeRowIdentity(row)) ?? displayRootOf(row)
  }
}

// The desktop sidebar's group tree, as sections in list order; without groups, its plain project list.
export function planProjectGroupTree<S extends object>(args: {
  entries: readonly ProjectEntry[]
  catalog: Pick<ProjectSectionCatalog, 'projectGroups' | 'projectOrderBy' | 'repoOrder'>
  folderRowsByGroupId: ReadonlyMap<string, Worktree[]>
  /** While searching, a group with nothing matching is left out, as projects are. */
  narrowed: boolean
  projectSection: (entry: ProjectEntry) => S
  groupSection: (key: string, title: string, folderRows: readonly Worktree[]) => S
}): { sections: (S & TreeSection)[]; placements: Map<string, GroupTreePlacement> } {
  const folderScanGroupIds = new Set(
    args.catalog.projectGroups
      .filter((group) => group.createdFrom === 'folder-scan')
      .map(({ id }) => id)
  )
  const inFolderScanGroup = (groupId: string | null | undefined) =>
    groupId && folderScanGroupIds.has(groupId) ? { inFolderScanGroup: true } : {}
  const sections: (S & TreeSection)[] = []
  const atDepth = (depth: number) => (depth > 0 ? { projectGroupDepth: depth } : {})
  const placements = new Map<string, GroupTreePlacement>()
  const groupPath: string[] = []
  const appendProjectEntries = (
    projectEntries: readonly ProjectEntry[],
    baseDepth: number
  ): void => {
    for (const ordered of orderUmbrellaProjectSections(projectEntries)) {
      const totalDepth = baseDepth + (ordered.decoration.projectGroupDepth ?? 0)
      const ancestorKeys = [...groupPath, ...ordered.ancestorKeys]
      const sectionPayload = ordered.isSubfolderGroup
        ? {
            ...args.groupSection(ordered.key, ordered.section.label, []),
            isProjectGroup: true
          }
        : args.projectSection([ordered.key, ordered.section])
      if (totalDepth > 0 || ancestorKeys.length > 0) {
        placements.set(ordered.key, {
          ancestorKeys,
          rowView: {
            ...atDepth(totalDepth),
            ...inFolderScanGroup(ordered.section.repo?.projectGroupId)
          }
        })
      }
      sections.push({
        ...sectionPayload,
        ...(ordered.decoration.parentSectionKey
          ? { parentSectionKey: ordered.decoration.parentSectionKey }
          : {}),
        ...(ordered.decoration.count !== undefined ? { count: ordered.decoration.count } : {}),
        ...atDepth(totalDepth)
      })
    }
  }
  if (args.catalog.projectGroups.length === 0) {
    appendProjectEntries(withRepoSectionDisplayLabels(args.entries), 0)
    return { sections, placements }
  }
  walkProjectGroupTree(
    {
      entries: args.entries,
      projectGroups: args.catalog.projectGroups,
      folderCountByGroupId: new Map(
        [...args.folderRowsByGroupId].map(([groupId, rows]) => [
          groupId,
          rows.filter((row) => row.workspaceKind === 'folder-workspace').length
        ])
      ),
      projectOrderBy: args.catalog.projectOrderBy,
      repoOrder: args.catalog.repoOrder
    },
    {
      group: (group, depth, count) => {
        if (args.narrowed && count === 0) {
          return false
        }
        groupPath.length = depth
        const key = getProjectGroupHeaderKey(group.id)
        placements.set(key, {
          ancestorKeys: [...groupPath],
          rowView: { projectGroupDepth: depth + 1, ...inFolderScanGroup(group.id) }
        })
        groupPath.push(key)
        const rows = args.folderRowsByGroupId.get(group.id) ?? []
        sections.push({
          ...args.groupSection(key, group.name, rows),
          isProjectGroup: true,
          count,
          ...atDepth(depth)
        })
        return true
      },
      projects: (entries, depth) => {
        groupPath.length = depth
        appendProjectEntries(entries, depth)
      }
    }
  )
  return { sections, placements }
}

/** The section as listed under its groups; null while a group above it is collapsed. */
export function placeInProjectGroupTree(
  section: Section,
  placement: GroupTreePlacement | undefined,
  collapsed: ReadonlySet<string>
): Section | null {
  if (!placement) {
    return section
  }
  if (placement.ancestorKeys.some((key) => collapsed.has(key))) {
    return null
  }
  return {
    ...section,
    data: section.data.map((item) => ({ ...item, view: { ...item.view, ...placement.rowView } }))
  }
}
