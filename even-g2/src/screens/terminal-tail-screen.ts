// Unit 5: terminal tail view-model (spec S8) — last lines, paginated; header `term · <worktree>
// · i/n`. Frame's terminalId starts '' until the openTerminalTail effect resolves it (integrator
// wiring patches the frame once the real terminal subscription opens), so lines are empty until
// state.terminalTail.terminalId matches the frame.
//
// Finding #4: never render a blank body — every non-content state (no terminal resolved yet,
// still loading, host reported unavailable, resolved with zero lines) gets its own explicit
// message instead of falling through to an empty `''` page.
//
// Finding #8/#2: the frame's `page` field is interpreted here as an OFFSET FROM THE LATEST page
// (0 = latest, increasing = further back in history), not an absolute index into `pages` (which
// is oldest-first). Since offset 0 is recomputed against the live page count on every render,
// staying at offset 0 (i.e. never having scrolled) automatically tracks new output as it
// arrives — no separate "follow" flag needed. paginateHudBody never re-shuffles earlier page
// boundaries when lines are appended to the end (it packs greedily left-to-right), so a
// wearer who has scrolled to a nonzero offset keeps seeing pages fall further into history
// rather than being yanked back to the live edge.
//
// integrator: "click=latest" in the footer below describes intended behavior this file cannot
// finish alone — reduceClick() in hud-navigation.ts currently no-ops for the terminalTail screen
// (see reduceClick's `if (frame.screen === 'dashboard') ...` fallthrough). Add a branch there:
// when frame.screen === 'terminalTail' and frame.page !== 0, replaceTopFrame with { ...frame,
// page: 0 } instead of no-op, so a single click resets to the latest page.
import type { HudScreenPage } from '../hud/hud-page-spec'
import { paginateHudBody } from '../hud/hud-text-pagination'
import { topFrame } from '../navigation/hud-navigation-frames'
import type { ScreenFrame } from '../navigation/nav-contract'
import type { HudState } from '../state/hud-store'

export function terminalTailPageCount(lines: string[]): number {
  return Math.max(1, paginateHudBody(lines).length)
}

type TerminalTailFrame = Extract<ScreenFrame, { screen: 'terminalTail' }>
type TextPage = Extract<HudScreenPage, { layout: 'text' }>

function nonContentPage(header: string, body: string): TextPage {
  return { layout: 'text', header, body, footer: '2tap=back' }
}

export function renderTerminalTailScreen(state: HudState): TextPage {
  const frame = topFrame(state.nav) as TerminalTailFrame
  const worktree = state.dashboard.rows.find((r) => r.worktreeId === frame.worktreeId)
  const name = worktree?.displayName ?? frame.worktreeId
  const header = `term · ${name}`

  // No terminal handle resolved yet: the openTerminalTail effect hasn't patched the frame's
  // '' placeholder with a real terminal id, so there is nothing to subscribe to at all.
  if (frame.terminalId === '') {
    return nonContentPage(header, 'No active terminal')
  }

  const tail = state.terminalTail
  const matchesFrame = tail.terminalId === frame.terminalId
  if (!matchesFrame || tail.loading) {
    return nonContentPage(header, 'Loading terminal…')
  }
  if (tail.unavailable) {
    return nonContentPage(header, 'Terminal unavailable — check phone')
  }
  if (tail.lines.length === 0) {
    return nonContentPage(header, 'No output yet')
  }

  const pages = paginateHudBody(tail.lines)
  const pageCount = Math.max(1, pages.length)
  const offset = Math.min(Math.max(frame.page, 0), pageCount - 1)
  const index = pageCount - 1 - offset // offset 0 = latest (last) page

  return {
    layout: 'text',
    header: `${header} · ${index + 1}/${pageCount}`,
    body: pages[index] ?? '',
    footer: 'scroll=history  click=latest  2tap=back'
  }
}
