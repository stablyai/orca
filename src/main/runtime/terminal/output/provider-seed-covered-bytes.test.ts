import { describe, expect, it } from 'vitest'
import type { RuntimeHeadlessTerminal } from '../records/runtime-terminal-state-records'
import {
  admitWhileRecovering,
  newGapRecovery,
  releaseRecoveryQueue
} from './provider-seed-covered-bytes'

const CHUNK = 'x'.repeat(64 * 1024)

describe('admitWhileRecovering', () => {
  it.each([300, 3_000])(
    'holds at most 32 MiB across %i capturing terminals however long captures wait',
    (terminals) => {
      const states = Array.from(
        { length: terminals },
        () =>
          ({
            gapReseed: { ...newGapRecovery(0), capturing: true }
          }) as unknown as RuntimeHeadlessTerminal
      )
      let held = 0
      let overflowed = 0
      for (let round = 1; round <= 20; round++) {
        for (const state of states) {
          const admitted = admitWhileRecovering(state, CHUNK, round * CHUNK.length, false, 0)
          if (!admitted.queued) {
            overflowed++
            expect(state.gapReseed?.frontier).toBe(round * CHUNK.length)
          } else {
            held += CHUNK.length
          }
        }
      }
      expect(held).toBeLessThanOrEqual(32 * 1024 * 1024)
      expect(overflowed).toBeGreaterThan(0)
      for (const state of states) {
        releaseRecoveryQueue(state.gapReseed, state.gapReseed?.queuedChars ?? 0)
      }
    }
  )

  it('keeps steady output before the capture is sent out of the queue without moving the frontier', () => {
    const state = { gapReseed: newGapRecovery(100) } as unknown as RuntimeHeadlessTerminal
    for (let i = 1; i <= 50; i++) {
      const admitted = admitWhileRecovering(
        state,
        `${CHUNK}\x1b[6n`,
        100 + i * CHUNK.length,
        true,
        i
      )
      expect(admitted.queued).toBe(false)
    }
    expect(state.gapReseed?.frontier).toBe(100)
    expect(state.gapReseed?.pendingQueries).toHaveLength(50)
    expect(state.gapReseed?.suppressedTail).toHaveLength(4096)
  })
})
