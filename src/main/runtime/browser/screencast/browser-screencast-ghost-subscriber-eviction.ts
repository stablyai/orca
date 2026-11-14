// Refusal may mean lost E2EE/socket, transient backpressure or our pre-ready gate.
// Require prior delivery and consecutive refusals before inferring a ghost viewer.
export type ScreencastSubscriberDeliveryState = {
  refusalStreak: number
  hasDeliveredFrame: boolean
}

// Count wasted produced frames, not wall time: 90 is ~6s at the default 15fps; idle pages never evict.
export const BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT = 90

export const INITIAL_SCREENCAST_SUBSCRIBER_DELIVERY: ScreencastSubscriberDeliveryState = {
  refusalStreak: 0,
  hasDeliveredFrame: false
}

export function recordScreencastSubscriberSend(
  state: ScreencastSubscriberDeliveryState,
  delivered: boolean
): ScreencastSubscriberDeliveryState {
  if (delivered) {
    return { refusalStreak: 0, hasDeliveredFrame: true }
  }
  return { refusalStreak: state.refusalStreak + 1, hasDeliveredFrame: state.hasDeliveredFrame }
}

// Never-reached viewers may still be behind the pre-ready gate; leave those to heartbeat reaping.
export function screencastSubscriberIsGhost(state: ScreencastSubscriberDeliveryState): boolean {
  return (
    state.hasDeliveredFrame &&
    state.refusalStreak >= BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT
  )
}
