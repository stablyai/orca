import { resolveWorktreeLineageParents } from '../../../src/shared/resolved-worktree-lineage'
import {
  buildWorktreeOccurrencePlan,
  getExpandedWorktreeOccurrences,
  type WorktreeOccurrencePlan
} from '../../../src/shared/worktree-occurrence-plan'
import type { Worktree } from './workspace-list-types'
import { getWorktreeRowIdentity } from './worktree-host-row-identity'

type WorktreeLineageIdentitySource = Pick<Worktree, 'worktreeId' | 'hostId'>

export function getMobileWorkspaceLineageGroupKey(worktree: WorktreeLineageIdentitySource): string {
  return `workspace-lineage:${encodeURIComponent(getWorktreeRowIdentity(worktree))}`
}

/** Children keyed by parent row identity, over valid edges between visible stores. */
export function getMobileWorkspaceLineageChildren(
  worktrees: readonly Worktree[],
  filterRepoIds?: readonly string[]
): Map<string, Worktree[]> {
  const rows = worktrees.map((row) => ({
    ...row,
    id: row.worktreeId,
    instanceId: row.worktreeInstanceId
  }))
  const parents = resolveWorktreeLineageParents(rows, (row) =>
    row.savedLineage !== undefined
      ? row.savedLineage
      : row.parentWorktreeId
        ? {
            parentWorktreeId: row.parentWorktreeId,
            worktreeInstanceId: row.lineageWorktreeInstanceId,
            parentWorktreeInstanceId: row.parentWorktreeInstanceId
          }
        : null
  )
  const childrenByParentIdentity = new Map<string, Worktree[]>()
  for (const [child, parent] of parents) {
    const key = getWorktreeRowIdentity(parent)
    const siblings = childrenByParentIdentity.get(key) ?? []
    siblings.push(child)
    childrenByParentIdentity.set(key, siblings)
  }
  if (filterRepoIds && filterRepoIds.length > 0) {
    const projectRows = new Set(
      worktrees.filter((row) => filterRepoIds.includes(row.repoId)).map(getWorktreeRowIdentity)
    )
    for (const [parent, children] of childrenByParentIdentity) {
      if (!projectRows.has(parent)) {
        childrenByParentIdentity.delete(parent)
      } else {
        childrenByParentIdentity.set(
          parent,
          children.filter((child) => projectRows.has(getWorktreeRowIdentity(child)))
        )
      }
    }
  }
  return childrenByParentIdentity
}

export function getMobileOccurrenceRows(
  plan: WorktreeOccurrencePlan<Worktree>,
  sectionKey: string,
  collapsedGroups: ReadonlySet<string>
): Worktree[] {
  return getExpandedWorktreeOccurrences(plan.bySection.get(sectionKey) ?? [], (worktree) =>
    collapsedGroups.has(getMobileWorkspaceLineageGroupKey(worktree))
  ).map((occurrence) => ({
    ...occurrence.row,
    sectionListKey: occurrence.key,
    lineageDepth: occurrence.depth,
    lineageChildCount: occurrence.childCount,
    lineageCollapsed:
      occurrence.childCount > 0 &&
      collapsedGroups.has(getMobileWorkspaceLineageGroupKey(occurrence.row)),
    isLastLineageChild: occurrence.isLastChild,
    showProjectName: occurrence.showProjectName
  }))
}

export function applyMobileWorkspaceLineage(
  worktrees: readonly Worktree[],
  collapsedGroups: ReadonlySet<string> = new Set()
): Worktree[] {
  const plan = buildWorktreeOccurrencePlan({
    rows: worktrees,
    childrenByParentIdentity: getMobileWorkspaceLineageChildren(worktrees),
    identityOf: getWorktreeRowIdentity,
    isPinned: () => false,
    duplicatePinned: false,
    sectionsOf: () => [{ key: 'all', items: worktrees }],
    projectIdOf: (worktree) => worktree.repoId
  })
  return getMobileOccurrenceRows(plan, 'all', collapsedGroups)
}
