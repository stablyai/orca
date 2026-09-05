// Unit 5: host list view-model (spec S8) — native list, connected/offline glyph per host.
// Spec's example glyph "◆ name - ok" isn't in the verified firmware glyph set (hud-glyphs.ts
// only exports glyphs confirmed present in the font); GLYPH_DONE (●) substitutes for "ok".
import { GLYPH_DISCONNECTED, GLYPH_DONE } from '../hud/hud-glyphs'
import type { HudScreenPage } from '../hud/hud-page-spec'
import type { GlassesHostProfile, HudState } from '../state/hud-store'

export function renderHostListScreen(state: HudState): Extract<HudScreenPage, { layout: 'list' }> {
  const hosts = state.hosts
  const header = `Orca · ${hosts.length} host${hosts.length === 1 ? '' : 's'}`
  const items = hosts.map((host) => hostListItem(state, host))
  const footer = 'click=open  2tap=exit'

  return { layout: 'list', header, items: items.length > 0 ? items : ['No paired hosts'], footer }
}

function hostListItem(state: HudState, host: GlassesHostProfile): string {
  const online = state.connection.hostId === host.id && state.connection.state === 'connected'
  const glyph = online ? GLYPH_DONE : GLYPH_DISCONNECTED
  const status = online ? 'ok' : 'offline'
  return `${glyph} ${host.name} — ${status}`
}
