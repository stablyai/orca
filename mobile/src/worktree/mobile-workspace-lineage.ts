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

function hasValidLineageParent(worktree: Worktree, parent: Worktree): boolean {
  if (
    worktree.lineageWorktreeInstanceId === undefined &&
    worktree.parentWorktreeInstanceId === undefined
  ) {
    return true
  }
  // Match desktop’s instance guard so path reuse cannot attach a new workspace to stale lineage.
  return (
    worktree.worktreeInstanceId === worktree.lineageWorktreeInstanceId &&
    parent.worktreeInstanceId === worktree.parentWorktreeInstanceId
  )
}

/** Children keyed by parent row identity, over valid edges between the given rows only. */
export function getMobileWorkspaceLineageChildren(
  worktrees: readonly Worktree[]
): Map<string, Worktree[]> {
  const worktreeById = new Map(
    worktrees.map((worktree) => [getWorktreeRowIdentity(worktree), worktree])
  )
  const childrenByParentId = new Map<string, Worktree[]>()

  for (const worktree of worktrees) {
    const worktreeId = getWorktreeRowIdentity(worktree)
    const parentId = worktree.parentWorktreeId
    const parentIdentity = parentId
      ? getWorktreeRowIdentity({ worktreeId: parentId, hostId: worktree.hostId })
      : null
    const parent = parentIdentity ? worktreeById.get(parentIdentity) : undefined
    if (
      !parentIdentity ||
      parentIdentity === worktreeId ||
      !parent ||
      !hasValidLineageParent(worktree, parent)
    ) {
      continue
    }
    const children = childrenByParentId.get(parentIdentity) ?? []
    children.push(worktree)
    childrenByParentId.set(parentIdentity, children)
  }
  return childrenByParentId
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
