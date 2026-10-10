// Why: a `false` from sendRemoteBrowserScreencastFrame conflates three causes. The E2EE channel
// refuses permanently once its shared key is gone or the socket leaves OPEN — the force-quit
// client whose subscription would otherwise survive until the ws heartbeat reaps it. It refuses
// transiently while the outbound queue is over budget, which clears on drain. And a joining
// subscriber's own pre-ready gate refuses every frame until its ready event is emitted. Only a
// run of refusals by a subscriber already known to reach its socket isolates the first case.
export type ScreencastSubscriberDeliveryState = {
  refusalStreak: number
  hasDeliveredFrame: boolean
}

// Why 90: the streak advances only while frames are actually produced, so the eviction delay
// tracks wasted encode-and-fanout work rather than wall time. At the default budget
// (everyNthFrame 2 over a 30fps page) that is ~6s, well inside the reap this exists to beat,
// while an idle page costs nothing and never evicts. It is also far past any single backpressure
// hiccup: a link that has refused 90 consecutive frames is showing its viewer nothing.
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

// Why the delivered-once precondition: until a frame has landed, refusals carry no information
// about the viewer — they are indistinguishable from the pre-ready gate — so a subscriber that
// has never been reached is left to the heartbeat rather than guessed at.
export function screencastSubscriberIsGhost(state: ScreencastSubscriberDeliveryState): boolean {
  return (
    state.hasDeliveredFrame &&
    state.refusalStreak >= BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT
  )
}
