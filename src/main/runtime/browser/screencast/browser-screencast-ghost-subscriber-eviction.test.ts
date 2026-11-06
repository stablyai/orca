import { describe, expect, it } from 'vitest'
import {
  BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT,
  INITIAL_SCREENCAST_SUBSCRIBER_DELIVERY,
  recordScreencastSubscriberSend,
  screencastSubscriberIsGhost,
  type ScreencastSubscriberDeliveryState
} from './browser-screencast-ghost-subscriber-eviction'

function replay(outcomes: readonly boolean[]): ScreencastSubscriberDeliveryState {
  return outcomes.reduce(recordScreencastSubscriberSend, INITIAL_SCREENCAST_SUBSCRIBER_DELIVERY)
}

function refusals(count: number): boolean[] {
  return Array.from({ length: count }, () => false)
}

describe('screencast ghost-subscriber delivery state', () => {
  it('grows the streak on refusal and resets it on any delivery', () => {
    expect(replay([false, false, false])).toEqual({ refusalStreak: 3, hasDeliveredFrame: false })
    expect(replay([false, false, true])).toEqual({ refusalStreak: 0, hasDeliveredFrame: true })
    expect(replay([true, false, false])).toEqual({ refusalStreak: 2, hasDeliveredFrame: true })
  })

  it('remembers a delivery for the rest of the subscription', () => {
    expect(replay([true, ...refusals(5)]).hasDeliveredFrame).toBe(true)
  })

  it('evicts only after the limit is reached by a subscriber that has been reached once', () => {
    const atLimit = replay([true, ...refusals(BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT)])
    expect(screencastSubscriberIsGhost(atLimit)).toBe(true)
    const belowLimit = replay([
      true,
      ...refusals(BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT - 1)
    ])
    expect(screencastSubscriberIsGhost(belowLimit)).toBe(false)
  })

  // Pre-ready refusals describe our gate, not viewer socket health.
  it('never evicts a subscriber no frame has ever reached', () => {
    const neverReached = replay(refusals(BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT * 10))
    expect(neverReached.refusalStreak).toBeGreaterThan(
      BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT
    )
    expect(screencastSubscriberIsGhost(neverReached)).toBe(false)
  })

  it('never reaches the limit while deliveries keep interleaving', () => {
    let state = INITIAL_SCREENCAST_SUBSCRIBER_DELIVERY
    for (let frame = 0; frame < BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT * 4; frame += 1) {
      state = recordScreencastSubscriberSend(state, frame % 3 === 0)
      expect(screencastSubscriberIsGhost(state)).toBe(false)
    }
  })

  // Bound eviction between a backpressure hiccup and heartbeat reaping.
  it('keeps the limit inside the window that makes eviction meaningful', () => {
    expect(BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT).toBeGreaterThan(10)
    expect(BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT).toBeLessThan(900)
  })
})
