import { describe, expect, it } from 'vitest'
import { MobileNativeChatScrollCoordinator } from './mobile-native-chat-scroll-coordinator'

const historyMetrics = {
  contentOffset: { y: 100 },
  contentSize: { height: 1000 },
  layoutMeasurement: { height: 400 }
}
const bottomMetrics = {
  contentOffset: { y: 600 },
  contentSize: { height: 1000 },
  layoutMeasurement: { height: 400 }
}

describe('MobileNativeChatScrollCoordinator', () => {
  it('does not confuse a programmatic stale offset with user intent', () => {
    const coordinator = new MobileNativeChatScrollCoordinator()

    coordinator.updateMetrics(historyMetrics)

    expect(coordinator.shouldFollowTail()).toBe(true)
    expect(coordinator.shouldShowJumpToLatest()).toBe(false)
  })

  it('gives an active interaction ownership before metrics arrive', () => {
    const coordinator = new MobileNativeChatScrollCoordinator()

    coordinator.beginInteraction()

    expect(coordinator.shouldFollowTail()).toBe(false)
  })

  it('suspends automatic tail writes without changing the follow intent', () => {
    const coordinator = new MobileNativeChatScrollCoordinator()

    coordinator.suspendFollowing()

    expect(coordinator.shouldFollowTail()).toBe(false)
    expect(coordinator.shouldShowJumpToLatest()).toBe(false)
    coordinator.finishInteraction()
    expect(coordinator.shouldFollowTail()).toBe(true)
  })

  it('keeps history mode after an interaction settles away from the tail', () => {
    const coordinator = new MobileNativeChatScrollCoordinator()
    coordinator.beginInteraction()
    coordinator.updateMetrics(historyMetrics)

    coordinator.finishInteraction()

    expect(coordinator.shouldFollowTail()).toBe(false)
    expect(coordinator.shouldShowJumpToLatest()).toBe(true)
  })

  it('resumes following when an interaction settles at the tail', () => {
    const coordinator = new MobileNativeChatScrollCoordinator()
    coordinator.beginInteraction()
    coordinator.updateMetrics(bottomMetrics)

    coordinator.finishInteraction()

    expect(coordinator.shouldFollowTail()).toBe(true)
  })

  it('resets a new session to tail following', () => {
    const coordinator = new MobileNativeChatScrollCoordinator()
    coordinator.beginInteraction()
    coordinator.updateMetrics(historyMetrics)
    coordinator.finishInteraction()

    coordinator.reset()

    expect(coordinator.shouldFollowTail()).toBe(true)
    expect(coordinator.shouldShowJumpToLatest()).toBe(false)
  })
})
