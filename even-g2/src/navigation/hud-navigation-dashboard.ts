// Unit 5 helper: dashboard scroll/click reducer logic, split out of hud-navigation.ts to keep
// that file under the line budget. Dashboard tracks a row `cursor` (used when it fits on one
// page: scroll = select, click = drill into that worktree) and a `page` index (used once it
// doesn't: scroll = page-turn, click = open worktreeList) — spec's "footer states current click
// meaning" — as separate fields so a row-set shrink can clamp/normalize each independently
// rather than one stale dual-purpose number silently meaning the wrong thing.
import type { NavContext, NavState, ScreenFrame } from './nav-contract'
import {
  clampToRange as clamp,
  NO_EFFECTS,
  pushFrame,
  type ReducedNav,
  replaceTopFrame,
  unchangedNav as unchanged
} from './hud-navigation-frames'

export type DashboardFrame = Extract<ScreenFrame, { screen: 'dashboard' }>
export type { ReducedNav }

function normalizedDashboardBounds(
  ctx: NavContext,
  frame: DashboardFrame
): { rowCount: number; pageCount: number; cursor: number; page: number } {
  const rowCount = ctx.worktreeCount(frame.hostId)
  const pageCount = ctx.dashboardPageCount(frame.hostId)
  return {
    rowCount,
    pageCount,
    cursor: clamp(frame.cursor, 0, Math.max(rowCount - 1, 0)),
    page: clamp(frame.page, 0, Math.max(pageCount - 1, 0))
  }
}

export function reduceDashboardScroll(
  state: NavState,
  ctx: NavContext,
  frame: DashboardFrame,
  direction: -1 | 1
): ReducedNav {
  const { rowCount, pageCount, cursor, page } = normalizedDashboardBounds(ctx, frame)
  if (pageCount > 1) {
    const nextPage = clamp(page + direction, 0, pageCount - 1)
    if (nextPage === frame.page && cursor === frame.cursor) {
      return unchanged(state)
    }
    return {
      state: replaceTopFrame(state, { ...frame, cursor, page: nextPage }),
      effects: NO_EFFECTS
    }
  }
  if (rowCount <= 0) {
    return unchanged(state)
  }
  const nextCursor = clamp(cursor + direction, 0, rowCount - 1)
  if (nextCursor === frame.cursor && page === frame.page) {
    return unchanged(state)
  }
  return {
    state: replaceTopFrame(state, { ...frame, cursor: nextCursor, page }),
    effects: NO_EFFECTS
  }
}

export function reduceDashboardClick(
  state: NavState,
  ctx: NavContext,
  frame: DashboardFrame
): ReducedNav {
  const { rowCount, pageCount, cursor, page } = normalizedDashboardBounds(ctx, frame)
  const changed = cursor !== frame.cursor || page !== frame.page
  const baseState = changed ? replaceTopFrame(state, { ...frame, cursor, page }) : state

  if (pageCount > 1) {
    const next = pushFrame(baseState, {
      screen: 'worktreeList',
      hostId: frame.hostId,
      selectedIndex: 0,
      page: 0
    })
    return { state: next, effects: NO_EFFECTS }
  }
  const worktreeId = rowCount > 0 ? ctx.worktreeIdAt(frame.hostId, cursor) : null
  if (worktreeId === null) {
    return { state: baseState, effects: NO_EFFECTS }
  }
  const next = pushFrame(baseState, {
    screen: 'terminalTail',
    hostId: frame.hostId,
    worktreeId,
    terminalId: '',
    page: 0
  })
  return { state: next, effects: [{ kind: 'openTerminalTail', worktreeId }] }
}
