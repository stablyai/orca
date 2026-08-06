import type { Worktree } from './workspace-list-types'

export function getMobileWorkspaceLineageGroupKey(worktreeId: string): string {
  return `workspace-lineage:${encodeURIComponent(worktreeId)}`
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

export function applyMobileWorkspaceLineage(
  worktrees: readonly Worktree[],
  collapsedGroups: ReadonlySet<string> = new Set()
): Worktree[] {
  const visibleIds = new Set(worktrees.map((worktree) => worktree.worktreeId))
  const worktreeById = new Map(worktrees.map((worktree) => [worktree.worktreeId, worktree]))
  const childrenByParentId = new Map<string, Worktree[]>()
  const childIds = new Set<string>()

  for (const worktree of worktrees) {
    const parentId = worktree.parentWorktreeId
    const parent = parentId ? worktreeById.get(parentId) : undefined
    if (
      !parentId ||
      parentId === worktree.worktreeId ||
      !visibleIds.has(parentId) ||
      !parent ||
      !hasValidLineageParent(worktree, parent)
    ) {
      continue
    }
    childIds.add(worktree.worktreeId)
    const children = childrenByParentId.get(parentId) ?? []
    children.push(worktree)
    childrenByParentId.set(parentId, children)
  }

  const result: Worktree[] = []
  const emitted = new Set<string>()
  const markDescendantsEmitted = (worktree: Worktree): void => {
    for (const child of childrenByParentId.get(worktree.worktreeId) ?? []) {
      if (!emitted.has(child.worktreeId)) {
        emitted.add(child.worktreeId)
        markDescendantsEmitted(child)
      }
    }
  }
  const emit = (worktree: Worktree, depth: number, isLastChild: boolean): void => {
    if (emitted.has(worktree.worktreeId)) {
      return
    }
    const children = childrenByParentId.get(worktree.worktreeId) ?? []
    const lineageCollapsed =
      children.length > 0 &&
      collapsedGroups.has(getMobileWorkspaceLineageGroupKey(worktree.worktreeId))
    emitted.add(worktree.worktreeId)
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

  const roots = worktrees.filter((worktree) => !childIds.has(worktree.worktreeId))
  roots.forEach((worktree, index) => {
    emit(worktree, 0, index === roots.length - 1)
  })

  for (const worktree of worktrees) {
    if (!emitted.has(worktree.worktreeId)) {
      // Why: malformed cyclic lineage should not hide every participant.
      emit(worktree, 0, true)
    }
  }

  return result
}
