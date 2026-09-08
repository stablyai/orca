import { describe, expect, it } from 'vitest'
import { MobileWebBrokerReplayWindow } from './mobile-web-broker-replay-window'

describe('mobile web broker replay window', () => {
  it('honours an id once and shares one window across request and subscription ids', () => {
    const replay = new MobileWebBrokerReplayWindow()

    expect(replay.accept('request-1')).toBe(true)
    expect(replay.accept('request-1')).toBe(false)
    expect(replay.accept('subscription-1')).toBe(true)
    expect(replay.accept('subscription-1')).toBe(false)
  })

  it('evicts the oldest id rather than exhausting a long-lived session', () => {
    const replay = new MobileWebBrokerReplayWindow()
    const ids = Array.from({ length: 5_000 }, (_, index) => `id-${index}`)

    for (const id of ids) {
      expect(replay.accept(id)).toBe(true)
    }

    expect(replay.accept(ids[0]!)).toBe(true)
    expect(replay.accept(ids.at(-1)!)).toBe(false)
  })

  it('clears all authority on disposal', () => {
    const replay = new MobileWebBrokerReplayWindow()

    replay.accept('request-1')
    replay.clear()

    expect(replay.accept('request-1')).toBe(true)
  })
})
