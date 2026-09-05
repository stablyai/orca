// Unit 5: dashboard view-model (spec S8) — one row per worktree, fullwidth-aligned columns,
// header shows running/waiting counts + page x/y, paginated when it overflows one page.
import {
  GLYPH_CURSOR_PREFIX,
  GLYPH_DISCONNECTED,
  GLYPH_DONE,
  GLYPH_IDLE,
  GLYPH_NEEDS_INPUT,
  GLYPH_WORKING,
  toFullwidthColumns
} from '../hud/hud-glyphs'
import type { HudScreenPage } from '../hud/hud-page-spec'
import { paginateHudBody } from '../hud/hud-text-pagination'
import { topFrame } from '../navigation/hud-navigation-frames'
import type { ScreenFrame } from '../navigation/nav-contract'
import type { DashboardRow, HudState } from '../state/hud-store'

const GLYPH_COL_WIDTH = 2
const NAME_COL_WIDTH = 20
const ELAPSED_COL_WIDTH = 6

export function statusGlyph(status?: DashboardRow['status']): string {
  switch (status) {
    case 'working':
    case 'active':
      return GLYPH_WORKING
    case 'permission':
      return GLYPH_NEEDS_INPUT
    case 'done':
      return GLYPH_DONE
    case 'inactive':
      return GLYPH_IDLE
    default:
      return GLYPH_DISCONNECTED
  }
}

function dashboardLines(rows: DashboardRow[]): string[] {
  const table = rows.map((row) => [
    statusGlyph(row.status),
    row.displayName,
    row.elapsedLabel ?? ''
  ])
  return toFullwidthColumns(table, [GLYPH_COL_WIDTH, NAME_COL_WIDTH, ELAPSED_COL_WIDTH])
}

/** Exported so the NavContext builder (integration wiring) computes the same page count the
 * reducer bounds scroll/click against — a single source of truth for "does this fit on 1 page". */
export function dashboardPageCount(rows: DashboardRow[]): number {
  return Math.max(1, paginateHudBody(dashboardLines(rows)).length)
}

export function renderDashboardScreen(state: HudState): Extract<HudScreenPage, { layout: 'text' }> {
  const frame = topFrame(state.nav) as Extract<ScreenFrame, { screen: 'dashboard' }>
  const rows = state.dashboard.rows
  const lines = dashboardLines(rows)
  const pages = paginateHudBody(lines)
  const pageCount = Math.max(1, pages.length)
  const paginated = pageCount > 1
  const page = paginated ? Math.min(frame.page, pageCount - 1) : 0

  const running = rows.filter((r) => r.status === 'working' || r.status === 'active').length
  const waiting = rows.filter((r) => r.status === 'permission').length
  const header = `Orca · ${running} running · ${waiting} waiting · page ${page + 1}/${pageCount}`
  const footer = paginated
    ? 'scroll=pages  click=list  2tap=back'
    : 'scroll=select  click=open  2tap=back'
  const body = dashboardBody(rows, lines, pages, page, paginated, frame.cursor)

  return { layout: 'text', header, body, footer }
}

function dashboardBody(
  rows: DashboardRow[],
  lines: string[],
  pages: string[],
  page: number,
  paginated: boolean,
  cursor: number
): string {
  if (rows.length === 0) {
    return 'No worktrees yet'
  }
  if (paginated) {
    return pages[page] ?? ''
  }
  const selected = Math.min(Math.max(cursor, 0), lines.length - 1)
  return lines.map((line, i) => `${i === selected ? GLYPH_CURSOR_PREFIX : ' '} ${line}`).join('\n')
}
