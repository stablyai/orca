// Hard-block screen (spec S6): when status.get's protocol/min-compat versions fence this client
// against the connected host, the HUD must refuse to proceed and tell the user which side to
// update — never silently render a dashboard that may misread the host's data.
import type { CompatVerdict } from '@orca-shared/protocol-compat'
import type { HudScreenPage } from '../hud/hud-page-spec'

export function renderBlockedCompatScreen(
  verdict: Extract<CompatVerdict, { kind: 'blocked' }>
): HudScreenPage {
  const side = verdict.reason === 'mobile-too-old' ? 'this Even G2 app' : 'Orca on the desktop'
  return {
    layout: 'text',
    header: 'Version mismatch',
    body: `Update ${side} to connect.\nHost protocol ${verdict.desktopVersion}.`,
    footer: '2tap=exit'
  }
}
