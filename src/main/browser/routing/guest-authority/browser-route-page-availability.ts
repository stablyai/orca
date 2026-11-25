import type { BrowserRoutePageGuestIdentity } from './browser-route-page-authority'
import type { BrowserRouteGuestState } from './browser-route-webcontents-state'

export class BrowserRoutePageAvailability {
  private readonly listeners = new Map<
    string,
    Set<(registration: BrowserRoutePageGuestIdentity) => void>
  >()

  readonly watch = (
    browserPageId: string,
    listener: (registration: BrowserRoutePageGuestIdentity) => void
  ): (() => void) => {
    const listeners = this.listeners.get(browserPageId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(browserPageId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.listeners.delete(browserPageId)
      }
    }
  }

  report(registration: BrowserRoutePageGuestIdentity): void {
    for (const listener of this.listeners.get(registration.browserPageId) ?? []) {
      try {
        listener(registration)
      } catch {
        // Availability retirement must remain fail-closed if an observer fails.
      }
    }
  }
}

export function reportBrowserRoutePageAvailabilityLoss(
  state: BrowserRouteGuestState,
  availability: BrowserRoutePageAvailability
): void {
  const registration = state.registration
  if (state.retirementRequested || state.availabilityLossReported || !registration) {
    return
  }
  state.availabilityLossReported = true
  availability.report(registration)
}
