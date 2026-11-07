// Unit 5: dashboard view-model (spec S8) — one simple line per worktree (glyph, middle-
// ellipsized name, status word, elapsed). Row order comes straight from `dashboard.rows`
// (worktree-dashboard-state.ts sorts it urgency-first) so what the wearer sees lines up 1:1
// with what NavContext resolves cursor/click against. Branches on connection state + poll
// freshness (HIGH #3) so connecting/loading/stale/empty never render identically.
import {
  GLYPH_CURSOR_PREFIX,
  GLYPH_DISCONNECTED,
  GLYPH_DONE,
  GLYPH_IDLE,
  GLYPH_NEEDS_INPUT,
  GLYPH_WORKING,
  middleEllipsize
} from '../hud/hud-glyphs'
import type { HudScreenPage } from '../hud/hud-page-spec'
import { DASHBOARD_ROWS_PER_PAGE } from '../navigation/hud-navigation-dashboard'
import { isRootFrame, topFrame } from '../navigation/hud-navigation-frames'
import type { ScreenFrame } from '../navigation/nav-contract'
import { formatElapsedLabel } from '../state/worktree-dashboard-state'
import type { DashboardRow, HudState } from '../state/hud-store'

const NAME_MAX_CHARS = 20

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

function statusWord(status?: DashboardRow['status']): string {
  switch (status) {
    case 'working':
    case 'active':
      return 'running'
    case 'permission':
      return 'waiting'
    case 'done':
      return 'done'
    case 'inactive':
      return 'idle'
    default:
      return 'offline'
  }
}

// HIGH #5: a single robust line instead of the old fullwidth-padded table — no ragged columns,
// and the name keeps its distinguishing suffix via middle-ellipsis instead of a tail cut.
function dashboardLine(row: DashboardRow): string {
  const name = middleEllipsize(row.displayName, NAME_MAX_CHARS)
  const elapsed = row.elapsedLabel ? `  ${row.elapsedLabel}` : ''
  return `${statusGlyph(row.status)} ${name} — ${statusWord(row.status)}${elapsed}`
}

/** Exported so the NavContext builder (integration wiring) computes the same page count the
 * reducer bounds scroll/click against — a single source of truth for "does this fit on 1 page".
 * Fixed row-count pagination (DASHBOARD_ROWS_PER_PAGE), not paginateHudBody's char-budget
 * splitter (MEDIUM #7): the reducer needs an exact, cheap cursor->page mapping and only has
 * counts via NavContext, never row text. */
export function dashboardPageCount(rows: DashboardRow[]): number {
  return Math.max(1, Math.ceil(rows.length / DASHBOARD_ROWS_PER_PAGE))
}

function connectionScreen(
  state: HudState,
  frameHostId: string,
  hostName: string
): { header: string; body: string } | null {
  // v1 tracks exactly one host's connection at a time (nav-context.ts); if `connection` names a
  // different host (or none), it says nothing about THIS frame's host, so it can't be used to
  // render a connecting/disconnected message for it — fall through to the rows-based branches.
  if (state.connection.hostId !== frameHostId) {
    return null
  }
  switch (state.connection.state) {
    case 'connecting':
    case 'handshaking':
      return { header: `Connecting to ${hostName}…`, body: 'Connecting…' }
    case 'reconnecting':
      return { header: `Reconnecting to ${hostName}…`, body: 'Reconnecting…' }
    case 'disconnected':
    case 'auth-failed':
      return {
        header: `Not connected — ${hostName}`,
        body: state.connection.lastError ?? 'Not connected'
      }
    default:
      return null
  }
}

export function renderDashboardScreen(
  state: HudState,
  now: number = Date.now()
): Extract<HudScreenPage, { layout: 'text' }> {
  const frame = topFrame(state.nav) as Extract<ScreenFrame, { screen: 'dashboard' }>
  const hostName = state.hosts.find((h) => h.id === frame.hostId)?.name ?? frame.hostId
  const footer = isRootFrame(state.nav)
    ? 'scroll=select  click=open  2tap=exit'
    : 'scroll=select  click=open  2tap=back'

  // HIGH #3: connecting/handshaking/reconnecting/disconnected must never render like "0 rows".
  const connState = connectionScreen(state, frame.hostId, hostName)
  if (connState) {
    return { layout: 'text', ...connState, footer }
  }

  const { rows, fetchedAt, stale } = state.dashboard

  // Connected, but the first worktree.ps poll hasn't landed yet.
  if (fetchedAt === 0) {
    return { layout: 'text', header: 'Orca · Loading…', body: 'Loading…', footer }
  }

  const pageCount = dashboardPageCount(rows)
  const page = Math.min(Math.max(frame.page, 0), pageCount - 1)
  const cursor = Math.min(Math.max(frame.cursor, 0), Math.max(rows.length - 1, 0))
  const pageStart = page * DASHBOARD_ROWS_PER_PAGE
  const pageRows = rows.slice(pageStart, pageStart + DASHBOARD_ROWS_PER_PAGE)
  const body = rows.length === 0 ? 'No worktrees' : dashboardBody(pageRows, cursor - pageStart)

  // Poll is failing (or the connection dropped mid-poll): keep showing the last-proven rows, but
  // say so up front — a stale snapshot must never read as live (HIGH #3).
  if (stale) {
    const ago = formatElapsedLabel(fetchedAt, now)
    return { layout: 'text', header: `Connection lost — last update ${ago} ago`, body, footer }
  }

  // MEDIUM #6: lead the header with urgency (needs-input count) rather than a flat tally — rows
  // are already needs-input-first (worktree-dashboard-state.ts), so this just names what's up top.
  const needsInput = rows.filter((r) => r.status === 'permission').length
  const running = rows.filter((r) => r.status === 'working' || r.status === 'active').length
  const header =
    needsInput > 0
      ? `${GLYPH_NEEDS_INPUT} ${needsInput} need you · ${page + 1}/${pageCount}`
      : `Orca · ${running} running · ${page + 1}/${pageCount}`

  return { layout: 'text', header, body, footer }
}

function dashboardBody(pageRows: DashboardRow[], selectedInPage: number): string {
  return pageRows
    .map((row, i) => `${i === selectedInPage ? GLYPH_CURSOR_PREFIX : ' '} ${dashboardLine(row)}`)
    .join('\n')
}
