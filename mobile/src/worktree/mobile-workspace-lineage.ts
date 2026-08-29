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
  // Why: desktop rejects stale lineage when a path is reused by a new workspace
  // instance; mobile needs the same guard before nesting parent/child rows.
  return (
    worktree.worktreeInstanceId === worktree.lineageWorktreeInstanceId &&
    parent.worktreeInstanceId === worktree.parentWorktreeInstanceId
  )
}

/** Row identity of the row's nesting parent, or null when it must render as a lineage root. */
export function getMobileLineageParentIdentity(
  worktree: Worktree,
  worktreeByIdentity: ReadonlyMap<string, Worktree>
): string | null {
  const parentId = worktree.parentWorktreeId
  if (!parentId) {
    return null
  }
  const parentIdentity = getWorktreeRowIdentity({ worktreeId: parentId, hostId: worktree.hostId })
  if (parentIdentity === getWorktreeRowIdentity(worktree)) {
    return null
  }
  const parent = worktreeByIdentity.get(parentIdentity)
  if (!parent || !hasValidLineageParent(worktree, parent)) {
    return null
  }
  return parentIdentity
}

export function applyMobileWorkspaceLineage(
  worktrees: readonly Worktree[],
  collapsedGroups: ReadonlySet<string> = new Set()
): Worktree[] {
  const worktreeById = new Map(
    worktrees.map((worktree) => [getWorktreeRowIdentity(worktree), worktree])
  )
  const childrenByParentId = new Map<string, Worktree[]>()
  const childIds = new Set<string>()

  for (const worktree of worktrees) {
    const worktreeId = getWorktreeRowIdentity(worktree)
    const parentIdentity = getMobileLineageParentIdentity(worktree, worktreeById)
    if (!parentIdentity) {
      continue
    }
    childIds.add(worktreeId)
    const children = childrenByParentId.get(parentIdentity) ?? []
    children.push(worktree)
    childrenByParentId.set(parentIdentity, children)
  }

  const result: Worktree[] = []
  const emitted = new Set<string>()
  const markDescendantsEmitted = (worktree: Worktree): void => {
    for (const child of childrenByParentId.get(getWorktreeRowIdentity(worktree)) ?? []) {
      const childId = getWorktreeRowIdentity(child)
      if (!emitted.has(childId)) {
        emitted.add(childId)
        markDescendantsEmitted(child)
      }
    }
  }
  const emit = (worktree: Worktree, depth: number, isLastChild: boolean): void => {
    const worktreeId = getWorktreeRowIdentity(worktree)
    if (emitted.has(worktreeId)) {
      return
    }
    const children = childrenByParentId.get(worktreeId) ?? []
    const lineageCollapsed =
      children.length > 0 && collapsedGroups.has(getMobileWorkspaceLineageGroupKey(worktree))
    emitted.add(worktreeId)
    result.push({
      ...worktree,
      lineageDepth: depth,
      lineageChildCount: children.length,
      lineageCollapsed,
      isLastLineageChild: isLastChild
    })
    if (lineageCollapsed) {
      markDescendantsEmitted(worktree)
      return
    }
    children.forEach((child, index) => {
      emit(child, depth + 1, index === children.length - 1)
    })
  }

  const roots = worktrees.filter((worktree) => !childIds.has(getWorktreeRowIdentity(worktree)))
  roots.forEach((worktree, index) => {
    emit(worktree, 0, index === roots.length - 1)
  })

  for (const worktree of worktrees) {
    if (!emitted.has(getWorktreeRowIdentity(worktree))) {
      // Why: malformed cyclic lineage should not hide every participant.
      emit(worktree, 0, true)
    }
  }

  return result
}
