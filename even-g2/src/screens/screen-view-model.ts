// Unit 5: dispatches on state.nav's top ScreenFrame to the per-screen view-models (spec S8).
import { GLYPH_NEEDS_INPUT } from '../hud/hud-glyphs'
import type { HudScreenPage } from '../hud/hud-page-spec'
import { frameHostId, topFrame } from '../navigation/hud-navigation-frames'
import type { ScreenFrame } from '../navigation/nav-contract'
import type { HudState } from '../state/hud-store'
import { renderAskScreen } from './ask-screen'
import { renderBlockedCompatScreen } from './blocked-compat-screen'
import { renderDashboardScreen } from './dashboard-screen'
import { renderHostListScreen } from './host-list-screen'
import { renderPairingScreen } from './pairing-screen'
import { renderTerminalTailScreen } from './terminal-tail-screen'
import { renderWorktreeListScreen } from './worktree-list-screen'

export type { ScreenId } from '../navigation/nav-contract'

function renderForFrame(state: HudState, frame: ScreenFrame): HudScreenPage {
  switch (frame.screen) {
    case 'pairing':
      return renderPairingScreen(state)
    case 'hostList':
      return renderHostListScreen(state)
    case 'dashboard':
      return renderDashboardScreen(state)
    case 'worktreeList':
      return renderWorktreeListScreen(state)
    case 'ask':
      return renderAskScreen(state)
    case 'terminalTail':
      return renderTerminalTailScreen(state)
  }
}

// Integrator wiring (spec S8): a pending ask swaps header line 1 to a click-through nudge on
// any screen but the ask screen itself — a HUD must not steal the glance, but it must say why.
function pendingAskNudgeHeader(state: HudState, frame: ScreenFrame): string | null {
  if (frame.screen === 'ask') {
    return null
  }
  const hostId = frameHostId(frame)
  if (hostId === null || state.connection.hostId !== hostId) {
    return null
  }
  const entry = state.inbox.entries.find((e) => e.kind === 'ask')
  if (!entry) {
    return null
  }
  const worktree = state.dashboard.rows.find((row) => row.worktreeId === entry.worktreeId)
  const name = worktree?.displayName ?? entry.worktreeId ?? 'worktree'
  return `${GLYPH_NEEDS_INPUT} ${name} needs input — click`
}

export function renderScreen(state: HudState): HudScreenPage {
  // A blocked compat verdict for the connected host wins over every screen (spec S6).
  const compat = state.connection.compat
  if (compat?.kind === 'blocked' && state.connection.hostId !== null) {
    return renderBlockedCompatScreen(compat)
  }
  const frame = topFrame(state.nav)
  const page = renderForFrame(state, frame)
  const nudge = pendingAskNudgeHeader(state, frame)
  return nudge ? { ...page, header: nudge } : page
}
