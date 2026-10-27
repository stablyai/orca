import { getPiStateTitleStatus } from '../../shared/pi-state-title-marker'
import type { RuledScreen } from './screen-input-veto'

/** OMP alternate-screen overlays own input, including setup; its heading can occur as ordinary answer text. */
export function isOmpOverlayScreen(screen: RuledScreen): boolean {
  return screen.alternateScreen
}

/** OMP paints its idle title before setup too, so it cannot prove composer readiness. */
export function isOmpIdleStateTitle(title: string | null | undefined): boolean {
  return title !== null && title !== undefined && getPiStateTitleStatus(title) === 'idle'
}
