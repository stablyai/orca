// Unit 5 helper: hostList/worktreeList reducer logic, split out of hud-navigation.ts to keep
// that file under the line budget.
import type { NavContext, NavState, ScreenFrame } from './nav-contract'
import {
  clampToRange as clamp,
  NO_EFFECTS,
  pushFrame,
  type ReducedNav,
  replaceTopFrame,
  unchangedNav as unchanged,
  WORKTREE_LIST_PAGE_SIZE
} from './hud-navigation-frames'

export type HostListFrame = Extract<ScreenFrame, { screen: 'hostList' }>
export type WorktreeListFrame = Extract<ScreenFrame, { screen: 'worktreeList' }>

// worktreeList's items are a ≤20-item window into the full row set (firmware hard cap); crossing
// the top/bottom boundary of the current window turns our own page and rebuilds the native list,
// landing the highlight at the natural edge (top when advancing, bottom when going back).
export function reduceWorktreeListScroll(
  state: NavState,
  ctx: NavContext,
  frame: WorktreeListFrame,
  direction: -1 | 1
): ReducedNav {
  const pageCount = ctx.worktreeListPageCount(frame.hostId)
  const nextPage = clamp(frame.page + direction, 0, Math.max(pageCount - 1, 0))
  if (nextPage === frame.page) {
    return unchanged(state)
  }
  const nextPageSize = Math.min(
    WORKTREE_LIST_PAGE_SIZE,
    Math.max(ctx.worktreeCount(frame.hostId) - nextPage * WORKTREE_LIST_PAGE_SIZE, 0)
  )
  const selectedIndex =
    nextPage * WORKTREE_LIST_PAGE_SIZE + (direction > 0 ? 0 : Math.max(nextPageSize - 1, 0))
  return {
    state: replaceTopFrame(state, { ...frame, page: nextPage, selectedIndex }),
    effects: NO_EFFECTS
  }
}

// SDK drops listItemIndex for an item-0 click (quirk); trust that quirk (resolve to 0) only
// when a label proves this really was a list click. Never fall back to a stale tracked
// cursor — after a rebuild or back-navigation it can disagree with what firmware visually
// selected (always item 0 in this quirk, per the normalizer). Genuinely unusable input
// (index -1, no label) fails closed rather than guessing.
function resolveListIndex(rawIndex: number, label: string | undefined): number | null {
  if (rawIndex >= 0) {
    return rawIndex
  }
  return label !== undefined ? 0 : null
}

export function reduceHostListSelect(
  state: NavState,
  ctx: NavContext,
  frame: HostListFrame,
  rawIndex: number,
  label: string | undefined
): ReducedNav {
  const index = resolveListIndex(rawIndex, label)
  if (index === null) {
    return unchanged(state)
  }
  const tracked = replaceTopFrame(state, { ...frame, selectedIndex: index })
  const hostId = ctx.hostIdAt(index)
  if (hostId === null) {
    return { state: tracked, effects: NO_EFFECTS }
  }
  return {
    state: pushFrame(tracked, { screen: 'dashboard', hostId, cursor: 0, page: 0 }),
    effects: [{ kind: 'connectHost', hostId }]
  }
}

export function reduceWorktreeListSelect(
  state: NavState,
  ctx: NavContext,
  frame: WorktreeListFrame,
  rawIndex: number,
  label: string | undefined
): ReducedNav {
  const localIndex = resolveListIndex(rawIndex, label)
  if (localIndex === null) {
    return unchanged(state)
  }
  // The click reports an index local to the current ≤20-item page; resolve the real row with
  // the page offset applied (spec: `page * pageSize + localIndex`).
  const globalIndex = frame.page * WORKTREE_LIST_PAGE_SIZE + localIndex
  const tracked = replaceTopFrame(state, { ...frame, selectedIndex: globalIndex })
  const worktreeId = ctx.worktreeIdAt(frame.hostId, globalIndex)
  if (worktreeId === null) {
    return { state: tracked, effects: NO_EFFECTS }
  }
  const next = pushFrame(tracked, {
    screen: 'terminalTail',
    hostId: frame.hostId,
    worktreeId,
    terminalId: '',
    page: 0
  })
  return { state: next, effects: [{ kind: 'openTerminalTail', worktreeId }] }
}
