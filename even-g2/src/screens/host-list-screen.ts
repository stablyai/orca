// Unit 5: host list view-model (spec S8) — native list, connected/offline glyph per host.
// Spec's example glyph "◆ name - ok" isn't in the verified firmware glyph set (hud-glyphs.ts
// only exports glyphs confirmed present in the font); GLYPH_DONE (●) substitutes for "ok".
//
// HIGH #3: v1 only ever tracks ONE host's connection state at a time (nav-context.ts), so a host
// that isn't the currently-targeted one has no known status at all — labeling it "offline" was a
// guess, not a fact. Only the currently-targeted host gets a real status word; every other host
// just says "not connected" (neutral, no claim either way).
import { GLYPH_DISCONNECTED, GLYPH_DONE } from '../hud/hud-glyphs'
import type { HudScreenPage } from '../hud/hud-page-spec'
import type { GlassesHostProfile, HudState } from '../state/hud-store'

const PAIRING_INSTRUCTION = "Open Orca on your phone's Even app page to pair."

export function renderHostListScreen(state: HudState): Extract<HudScreenPage, { layout: 'list' }> {
  const hosts = state.hosts

  // HIGH #3: 0 paired hosts is a pairing prompt, not an empty list — echo pairing-screen.ts's
  // instruction instead of a "No paired hosts" placeholder with a nonsensical "click=open" hint.
  if (hosts.length === 0) {
    return {
      layout: 'list',
      header: 'Orca · Pair on phone',
      items: [PAIRING_INSTRUCTION],
      footer: '2tap=exit'
    }
  }

  const header = `Orca · ${hosts.length} host${hosts.length === 1 ? '' : 's'}`
  const items = hosts.map((host) => hostListItem(state, host))
  const footer = 'click=open  2tap=exit'

  return { layout: 'list', header, items, footer }
}

function hostListItem(state: HudState, host: GlassesHostProfile): string {
  if (state.connection.hostId !== host.id) {
    return `${GLYPH_DISCONNECTED} ${host.name} — not connected`
  }
  switch (state.connection.state) {
    case 'connected':
      return `${GLYPH_DONE} ${host.name} — ok`
    case 'connecting':
    case 'handshaking':
    case 'reconnecting':
      return `${GLYPH_DISCONNECTED} ${host.name} — connecting`
    default:
      return `${GLYPH_DISCONNECTED} ${host.name} — offline`
  }
}
