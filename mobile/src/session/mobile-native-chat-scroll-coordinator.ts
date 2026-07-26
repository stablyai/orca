export const MOBILE_NATIVE_CHAT_BOTTOM_THRESHOLD_PX = 80

export type MobileNativeChatScrollMetrics = {
  contentOffset: { y: number }
  contentSize: { height: number }
  layoutMeasurement: { height: number }
}

function isNearBottom(metrics: MobileNativeChatScrollMetrics): boolean {
  const distance =
    metrics.contentSize.height - (metrics.contentOffset.y + metrics.layoutMeasurement.height)
  return distance < MOBILE_NATIVE_CHAT_BOTTOM_THRESHOLD_PX
}

export class MobileNativeChatScrollCoordinator {
  private following = true
  private interacting = false
  private nearBottom = true

  reset(): void {
    this.following = true
    this.interacting = false
    this.nearBottom = true
  }

  beginInteraction(): void {
    this.following = false
    this.interacting = true
  }

  suspendFollowing(): void {
    this.interacting = true
  }

  updateMetrics(metrics: MobileNativeChatScrollMetrics): void {
    this.nearBottom = isNearBottom(metrics)
  }

  finishInteraction(): void {
    this.interacting = false
    this.following = this.nearBottom
  }

  followLatest(): void {
    this.following = true
    this.interacting = false
    this.nearBottom = true
  }

  shouldFollowTail(): boolean {
    return this.following && !this.interacting
  }

  shouldShowJumpToLatest(): boolean {
    return !this.following && !this.nearBottom
  }
}
