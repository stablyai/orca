import {
  MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS,
  MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS
} from '../../../src/shared/mobile-web/bridge-contract'

// One window covers request and subscription ids alike: both are page-minted and honoured once.
const REPLAY_WINDOW =
  (MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS + MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS) * 4

export class MobileWebBrokerReplayWindow {
  private readonly ids = new Set<string>()

  /** An id evicted from the window while still in flight is caught by the broker's pending map. */
  accept(id: string): boolean {
    if (this.ids.has(id)) {
      return false
    }
    this.ids.add(id)
    if (this.ids.size > REPLAY_WINDOW) {
      const oldest = this.ids.values().next().value
      if (oldest !== undefined) {
        this.ids.delete(oldest)
      }
    }
    return true
  }

  clear(): void {
    this.ids.clear()
  }
}
