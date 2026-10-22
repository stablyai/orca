import { DESKTOP_PRESENCE_TTL_MS } from '../../shared/desktop-client-presence'

/** The last presence each attached desktop connection reported to this host. */
export class DesktopClientPresenceTracker {
  private readonly reports = new Map<string, { away: boolean; at: number }>()

  has(connectionId: string): boolean {
    return this.reports.has(connectionId)
  }

  report(connectionId: string, away: boolean, now: number): void {
    this.reports.set(connectionId, { away, at: now })
  }

  forget(connectionId: string): void {
    this.reports.delete(connectionId)
  }

  /** True only on a fresh "present" report; silence, staleness and older desktops read as away. */
  anyPresent(now: number): boolean {
    let present = false
    for (const [connectionId, { away, at }] of this.reports) {
      if (now - at >= DESKTOP_PRESENCE_TTL_MS) {
        // Why prune: the next report re-registers the forget-on-close, so nothing can pile up.
        this.reports.delete(connectionId)
      } else if (!away) {
        present = true
      }
    }
    return present
  }
}
