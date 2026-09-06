import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'

/** Owns the one-way close of a session's startup query authority. */
export abstract class SessionStartupQueryAuthority {
  protected abstract readonly startupIngress: PtyStartupIngress

  closeStartupQueryAuthority(): number {
    return this.startupIngress.closeQueryAuthority()
  }
}
