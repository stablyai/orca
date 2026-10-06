import { getPiStateTitleStatus } from '../../shared/pi-state-title-marker'
import type { RuledScreen } from './screen-input-veto'

/**
 * OMP 18.4 runs its first-run setup wizard (splash, steps, outro) as a fullscreen overlay on the
 * alternate screen, and keys typed there drive the wizard, not the composer. Every other OMP
 * alternate-screen user is an overlay that owns input too. Why not the "Setup step N of M"
 * heading: it only ever appears there, and on the normal screen it is an answer's own text.
 */
export function isOmpOverlayScreen(screen: RuledScreen): boolean {
  return screen.alternateScreen
}

/** OMP's own idle state title (`π > cwd`), which it already paints before the setup wizard. */
export function isOmpIdleStateTitle(title: string | null | undefined): boolean {
  return title !== null && title !== undefined && getPiStateTitleStatus(title) === 'idle'
}
