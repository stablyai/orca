import { describe, expect, it } from 'vitest'
import type { RuntimeHeadlessTerminal } from '../records/runtime-terminal-state-records'
import { admitWhileRecovering, releaseRecoveryQueue } from './provider-seed-covered-bytes'

const CHUNK = 'x'.repeat(64 * 1024)

describe('admitWhileRecovering', () => {
  it.each([300, 3_000])(
    'holds at most 32 MiB across %i recovering terminals however long captures wait',
    (terminals) => {
      const states = Array.from(
        { length: terminals },
        () =>
          ({
            gapReseed: { frontier: 0, queuedChars: 0, queryCarry: '' }
          }) as unknown as RuntimeHeadlessTerminal
      )
      let held = 0
      let overflowed = 0
      for (let round = 1; round <= 20; round++) {
        for (const state of states) {
          const admitted = admitWhileRecovering(state, CHUNK, round * CHUNK.length)
          if (admitted.queriesOnly) {
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
})
