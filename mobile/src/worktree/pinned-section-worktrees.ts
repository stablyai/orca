import { buildMobileWorkspaceLineageEdges } from './mobile-workspace-lineage'
import { getWorktreeRowIdentity } from './worktree-host-row-identity'
import type { Worktree } from './workspace-list-types'

/**
 * Pinned-section membership, matching desktop's getPinnedSectionWorktrees:
 * pin is placement of the clicked row, and visible descendants follow a pinned
 * ancestor into the Pinned section. A pinned child never pulls its unpinned
 * parent in, and lineage edges never cross hosts. The traversal walks the full
 * catalog so a filtered-out middle generation still bridges to visible
 * descendants, but only visible rows are returned. Iterative + cycle-safe for
 * deep lineage chains.
 */
export function getPinnedSectionWorktrees(
  allWorktrees: readonly Worktree[],
  visibleWorktrees: readonly Worktree[],
  isPinnedWorktree: (worktree: Worktree) => boolean
): Worktree[] {
  const pinnedSeeds = visibleWorktrees.filter(isPinnedWorktree)
  // Why: the catalog can hold up to 10k rows and this runs per render; with no
  // pinned rows (the common case) the edge scan and maps are pure overhead.
  if (pinnedSeeds.length === 0) {
    return []
  }
  const { childrenByParentId } = buildMobileWorkspaceLineageEdges(allWorktrees)
  const visibleIdentities = new Set(visibleWorktrees.map(getWorktreeRowIdentity))
  const included = new Set<string>()
  const seen = new Set<string>()
  const stack = pinnedSeeds.map(getWorktreeRowIdentity)

  while (stack.length > 0) {
    const identity = stack.pop()
    if (!identity || seen.has(identity)) {
      continue
    }
    seen.add(identity)
    if (visibleIdentities.has(identity)) {
      included.add(identity)
    }
    for (const child of childrenByParentId.get(identity) ?? []) {
      stack.push(getWorktreeRowIdentity(child))
    }
  }

  return visibleWorktrees.filter((worktree) => included.has(getWorktreeRowIdentity(worktree)))
}
