import type { MobileWebBridgeErrorCode } from '../../../src/shared/mobile-web/bridge-contract'

/** Why a reason and not just a cancel: a shell-side failure after the subscribe response has landed
 *  has no other frame to travel on, so the page would keep a live entry and freeze on its last
 *  value. `retryable` is what lets a caller decide whether re-subscribing can help. */
export type MobileWebSubscriptionClosure = {
  code: MobileWebBridgeErrorCode
  retryable: boolean
}

export type MobileWebPostSubscriptionClosed = (
  subscriptionId: string,
  closure: MobileWebSubscriptionClosure
) => void

/** Why fire-and-forget: this is the last frame of a subscription the shell has already retired, so
 *  a failed post has nothing left to unwind — and every caller is itself a failure path. */
export function mobileWebSubscriptionClosedPoster(sender: {
  subscriptionClosed: (
    subscriptionId: string,
    code: MobileWebBridgeErrorCode,
    retryable: boolean
  ) => Promise<void>
}): MobileWebPostSubscriptionClosed {
  return (subscriptionId, closure) => {
    void sender.subscriptionClosed(subscriptionId, closure.code, closure.retryable).catch(() => {})
  }
}
