import { DESKTOP_PRESENCE_TTL_MS } from '../../shared/desktop-client-presence'

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
        // Fresh reports re-register close cleanup, so pruning cannot accumulate entries.
        this.reports.delete(connectionId)
      } else if (!away) {
        present = true
      }
    }
    return present
  }
}
