// Unit 5: pairing view-model (spec S8) — typing on glasses is impossible, so this just points
// the user at the phone page's paste-code flow, plus current connection state for feedback.
import type { HudScreenPage } from '../hud/hud-page-spec'
import type { HudState } from '../state/hud-store'

export function renderPairingScreen(state: HudState): Extract<HudScreenPage, { layout: 'text' }> {
  return {
    layout: 'text',
    header: 'Orca · Pair on phone',
    body: pairingBody(state),
    footer: '2tap=exit'
  }
}

function pairingBody(state: HudState): string {
  switch (state.connection.state) {
    case 'connecting':
    case 'handshaking':
      return 'Connecting to Orca…'
    case 'reconnecting':
      return 'Reconnecting…'
    case 'auth-failed':
      return 'Pairing rejected. Re-pair on your phone.'
    default:
      return "Open Orca on your phone's Even app page to pair."
  }
}
