import { describe, expect, it } from 'vitest'
import { MobileWebMessageReplayWindow } from './mobile-web-message-replay-window'

describe('mobile web message replay window', () => {
  it('rejects recent IDs without permanently exhausting a long-lived session', () => {
    const replay = new MobileWebMessageReplayWindow(3)

    replay.remember('a')
    replay.remember('b')
    replay.remember('c')
    expect(replay.has('a')).toBe(true)

    replay.remember('d')
    expect(replay.has('a')).toBe(false)
    expect(replay.has('b')).toBe(true)
    expect(replay.has('d')).toBe(true)
  })

  it('refreshes an existing ID and clears all authority on disposal', () => {
    const replay = new MobileWebMessageReplayWindow(2)

    replay.remember('a')
    replay.remember('b')
    replay.remember('a')
    replay.remember('c')
    expect(replay.has('a')).toBe(true)
    expect(replay.has('b')).toBe(false)

    replay.clear()
    expect(replay.has('a')).toBe(false)
    expect(replay.has('c')).toBe(false)
  })
})
