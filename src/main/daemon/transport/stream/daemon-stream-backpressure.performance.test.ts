import { describe, expect, it } from 'vitest'
import { DaemonStreamBackpressure } from './daemon-stream-backpressure'

// Guards #51089: per-session pausing must not re-send pauses to every paused flood on each unrelated update.
describe('DaemonStreamBackpressure pause calls', () => {
  it.each([300, 3_000])(
    'an unrelated update makes no pause calls with %i quiet sessions and 10 paused floods',
    (quietSessions) => {
      let pauseCalls = 0
      const backpressure = new DaemonStreamBackpressure(
        () => {
          pauseCalls += 1
        },
        () => false
      )
      const queued = new Map<string, number>()
      for (let i = 0; i < quietSessions; i++) {
        queued.set(`quiet-${i}`, 100)
      }
      for (let i = 0; i < 10; i++) {
        queued.set(`flood-${i}`, 200 * 1024)
      }
      backpressure.setQueued('client', queued)
      expect(pauseCalls).toBe(10)

      queued.set('quiet-0', 101)
      backpressure.setQueued('client', queued)
      expect(pauseCalls).toBe(10)
    }
  )
})
