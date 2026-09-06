import {
  MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS,
  MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS
} from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebMessageReplayWindow } from './mobile-web-message-replay-window'

export class MobileWebBrokerReplayGuard {
  private readonly requests = new MobileWebMessageReplayWindow(
    MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS * 4
  )
  private readonly subscriptions = new MobileWebMessageReplayWindow(
    MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS * 4
  )

  acceptRequest(id: string, active: boolean): boolean {
    if (active || this.requests.has(id)) {
      return false
    }
    this.requests.remember(id)
    return true
  }

  acceptSubscription(id: string): boolean {
    if (this.subscriptions.has(id)) {
      return false
    }
    this.subscriptions.remember(id)
    return true
  }

  clear(): void {
    this.requests.clear()
    this.subscriptions.clear()
  }
}
