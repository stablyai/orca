// Unit 5 helper: dashboard scroll/click reducer logic, split out of hud-navigation.ts to keep
// that file under the line budget.
//
// MEDIUM #7: the dashboard keeps exactly ONE selectable cursor across every page. Scroll always
// moves it (turning the page at a boundary); click always opens whatever worktree it's on.
// There is no longer a row-count threshold where click's meaning silently flips from "open this
// worktree" to "open the worktreeList page-browser" — that used to happen right as a dashboard
// crossed one page, with nothing on screen announcing the swap. `page` is now purely DERIVED
// from `cursor` (see `pageForCursor`) rather than an independently-scrollable dimension; it's
// still stored on the frame (nav-contract.ts's ScreenFrame shape is fixed) so dashboard-screen.ts
// can slice the current page's rows without recomputing it.
//
// Cross-file note: this removes the only call site that ever pushed a `worktreeList` frame from
// the dashboard. worktree-list-screen.ts/hud-navigation-list-select.ts are otherwise unchanged
// and still work if something else pushes that frame, but nothing in this codebase does anymore
// — flagged for the integrator (see task report) rather than silently left half-reachable.
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

/** Shared with dashboard-screen.ts's render-time row slicing (imported from there) — the single
 * source of truth for "how many rows are on one dashboard page". Fixed-count rather than
 * paginateHudBody's char-budget splitter: NavContext only exposes counts/ids to this reducer,
 * never row text, so cursor->page has to be a cheap, exact `floor(cursor / N)` on both sides. */
export const DASHBOARD_ROWS_PER_PAGE = 9

function pageForCursor(cursor: number): number {
  return Math.floor(cursor / DASHBOARD_ROWS_PER_PAGE)
}

export function reduceDashboardScroll(
  state: NavState,
  ctx: NavContext,
  frame: DashboardFrame,
  direction: -1 | 1
): ReducedNav {
  const rowCount = ctx.worktreeCount(frame.hostId)
  if (rowCount <= 0) {
    return unchanged(state)
  }
  const cursor = clamp(frame.cursor, 0, rowCount - 1)
  const nextCursor = clamp(cursor + direction, 0, rowCount - 1)
  const nextPage = pageForCursor(nextCursor)
  if (nextCursor === frame.cursor && nextPage === frame.page) {
    return unchanged(state)
  }
  return {
    state: replaceTopFrame(state, { ...frame, cursor: nextCursor, page: nextPage }),
    effects: NO_EFFECTS
  }
}

export function reduceDashboardClick(
  state: NavState,
  ctx: NavContext,
  frame: DashboardFrame
): ReducedNav {
  const rowCount = ctx.worktreeCount(frame.hostId)
  const cursor = clamp(frame.cursor, 0, Math.max(rowCount - 1, 0))
  const page = rowCount > 0 ? pageForCursor(cursor) : 0
  const changed = cursor !== frame.cursor || page !== frame.page
  const baseState = changed ? replaceTopFrame(state, { ...frame, cursor, page }) : state

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
