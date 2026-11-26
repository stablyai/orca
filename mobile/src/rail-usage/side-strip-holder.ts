import { BRIDGE_TERMINAL_KEY_RAIL_GRANT } from '../mobile-web-shell/bridge/native-capabilities/bridge-terminal-key'
import type { BridgeSideStripFree } from '../mobile-web-shell/bridge/page-geometry/bridge-side-strip-cover'
import { sessionOfPageLocation } from '../navigation/page-location-session'

/** What a shell screen knows about its page when deciding whether the side strip is the page's. */
export type SideStripPageView = {
  ownsHostArea: boolean
  routeGrants: readonly string[]
  /** The page's own report that it lays itself across the strip; null from pages that never send it. */
  covered: boolean | null
  /** The span a covering page leaves empty, such as a collapsed chat's column; null when it names none. */
  free: BridgeSideStripFree | null
  /** Where the page last said it is; null before it says. */
  location: string | null
  /** The terminal key rail is drawn in the strip. */
  keyRailClaimed: boolean
}

/** How much of the side strip the page leaves the shell: all, none, or one span of it. */
export type SideStripRoom =
  | { kind: 'whole' }
  | { kind: 'none' }
  | ({ kind: 'span' } & BridgeSideStripFree)

const WHOLE: SideStripRoom = { kind: 'whole' }
const NONE: SideStripRoom = { kind: 'none' }

export function pageSideStripRoom(view: SideStripPageView): SideStripRoom {
  if (view.keyRailClaimed) {
    return NONE
  }
  // A page that names an empty span shows a chat, not a terminal.
  if (view.covered === true && view.free !== null) {
    return { kind: 'span', top: view.free.top, bottom: view.free.bottom }
  }
  // A session route keeps the strip for its terminal key rail even while no terminal is up.
  if (!view.ownsHostArea && view.routeGrants.includes(BRIDGE_TERMINAL_KEY_RAIL_GRANT)) {
    return NONE
  }
  if (view.covered !== null) {
    return view.covered ? NONE : WHOLE
  }
  // Older pages only say which session they show; the host page opens sessions inside itself.
  return view.ownsHostArea &&
    view.location !== null &&
    sessionOfPageLocation(view.location) !== null
    ? NONE
    : WHOLE
}
