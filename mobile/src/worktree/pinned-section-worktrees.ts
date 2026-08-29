import type { Worktree } from './workspace-list-types'
import { getMobileLineageParentIdentity } from './mobile-workspace-lineage'
import { getWorktreeRowIdentity } from './worktree-host-row-identity'

/** Host-side pin flag OR a device-local pin, which is keyed on the bare worktreeId. */
export function isWorktreePinned(w: Worktree, localPins: Set<string>): boolean {
  return w.isPinned || localPins.has(w.worktreeId)
}

/**
 * Rows the Pinned section owns: the pinned rows plus their visible lineage descendants,
 * mirroring desktop's getPinnedSectionWorktrees. Pin is placement of the clicked row, so a
 * pinned parent must take its subtree along — otherwise single-location strips the parent
 * out of its group and orphans the children there at depth 0.
 */
export function getPinnedSectionWorktrees(
  worktrees: readonly Worktree[],
  pinnedIds: Set<string>
): Worktree[] {
  const included = new Set(
    worktrees.filter((w) => isWorktreePinned(w, pinnedIds)).map(getWorktreeRowIdentity)
  )
  if (included.size === 0) {
    return []
  }
  const worktreeByIdentity = new Map(worktrees.map((w) => [getWorktreeRowIdentity(w), w]))
  const childrenByParentIdentity = new Map<string, Worktree[]>()
  for (const worktree of worktrees) {
    const parentIdentity = getMobileLineageParentIdentity(worktree, worktreeByIdentity)
    if (!parentIdentity) {
      continue
    }
    const children = childrenByParentIdentity.get(parentIdentity) ?? []
    children.push(worktree)
    childrenByParentIdentity.set(parentIdentity, children)
  }

  const pending = [...included]
  while (pending.length > 0) {
    const identity = pending.pop()
    if (identity === undefined) {
      continue
    }
    for (const child of childrenByParentIdentity.get(identity) ?? []) {
      const childIdentity = getWorktreeRowIdentity(child)
      if (!included.has(childIdentity)) {
        included.add(childIdentity)
        pending.push(childIdentity)
      }
    }
  }

  return worktrees.filter((w) => included.has(getWorktreeRowIdentity(w)))
}
