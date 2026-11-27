import { describe, expect, it } from 'vitest'
import { DaemonStreamBackpressure } from './daemon-stream-backpressure'

describe('DaemonStreamBackpressure', () => {
  it('pauses a flooding session on its own backlog and never pauses its quiet sibling', () => {
    const paused = new Map<string, boolean>()
    const backpressure = new DaemonStreamBackpressure(
      (sessionId, isPaused) => paused.set(sessionId, isPaused),
      () => false
    )
    // 400 KB of held output is far below the 4 MB global cap.
    backpressure.setQueued(
      'client',
      new Map([
        ['flood', 200 * 1024],
        ['tui', 1024]
      ])
    )
    expect(paused.get('flood')).toBe(true)
    expect(paused.has('tui')).toBe(false)

    backpressure.setQueued(
      'client',
      new Map([
        ['flood', 32 * 1024],
        ['tui', 1024]
      ])
    )
    expect(paused.get('flood')).toBe(false)
  })
})
