// Unit 5: worktree list view-model (spec S8) — native list, status glyph prefix per row.
import type { HudScreenPage } from '../hud/hud-page-spec'
import { topFrame, WORKTREE_LIST_PAGE_SIZE } from '../navigation/hud-navigation-frames'
import type { ScreenFrame } from '../navigation/nav-contract'
import type { HudState } from '../state/hud-store'
import { statusGlyph } from './dashboard-screen'

export function worktreeListPageCount(worktreeCount: number): number {
  return Math.max(1, Math.ceil(worktreeCount / WORKTREE_LIST_PAGE_SIZE))
}

export function renderWorktreeListScreen(
  state: HudState
): Extract<HudScreenPage, { layout: 'list' }> {
  const frame = topFrame(state.nav) as Extract<ScreenFrame, { screen: 'worktreeList' }>
  const rows = state.dashboard.rows
  const pageCount = worktreeListPageCount(rows.length)
  const page = Math.min(frame.page, pageCount - 1)
  const pageRows = rows.slice(
    page * WORKTREE_LIST_PAGE_SIZE,
    page * WORKTREE_LIST_PAGE_SIZE + WORKTREE_LIST_PAGE_SIZE
  )

  const header = `Worktrees · ${rows.length} · page ${page + 1}/${pageCount}`
  const items = pageRows.map((row) => `${statusGlyph(row.status)} ${row.displayName}`)
  const footer = 'click=open  2tap=back'

  return { layout: 'list', header, items: items.length > 0 ? items : ['No worktrees'], footer }
}
