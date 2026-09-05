// Unit 5: terminal tail view-model (spec S8) — last lines, paginated; header `term · <worktree>
// · i/n`. Frame's terminalId starts '' until the openTerminalTail effect resolves it (integrator
// wiring patches the frame once the real terminal subscription opens), so lines are empty until
// state.terminalTail.terminalId matches the frame.
import type { HudScreenPage } from '../hud/hud-page-spec'
import { paginateHudBody } from '../hud/hud-text-pagination'
import { topFrame } from '../navigation/hud-navigation-frames'
import type { ScreenFrame } from '../navigation/nav-contract'
import type { HudState } from '../state/hud-store'

export function terminalTailPageCount(lines: string[]): number {
  return Math.max(1, paginateHudBody(lines).length)
}

export function renderTerminalTailScreen(
  state: HudState
): Extract<HudScreenPage, { layout: 'text' }> {
  const frame = topFrame(state.nav) as Extract<ScreenFrame, { screen: 'terminalTail' }>
  const lines = state.terminalTail.terminalId === frame.terminalId ? state.terminalTail.lines : []
  const pages = paginateHudBody(lines)
  const pageCount = Math.max(1, pages.length)
  const page = Math.min(frame.page, pageCount - 1)

  const worktree = state.dashboard.rows.find((r) => r.worktreeId === frame.worktreeId)
  const name = worktree?.displayName ?? frame.worktreeId
  const header = `term · ${name} · ${page + 1}/${pageCount}`
  const body = pages[page] ?? ''
  const footer = 'scroll=pages  2tap=back'

  return { layout: 'text', header, body, footer }
}
