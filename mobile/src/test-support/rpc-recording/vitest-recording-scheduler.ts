import { act } from 'react-test-renderer'
import { vi } from 'vitest'
import type { RecordingScheduler } from './recording-scenario'

const RECORDING_EPOCH = new Date('2026-01-01T00:00:00Z')

/**
 * React's `enqueueTask` resolves its implementation by reading `module['require' + Math.random()]`
 * and memoizes the result, so it draws exactly one `Math.random()` the first time a process awaits
 * `act`. Drawn inside a recording, that draw ate the seeded sequence's first value and only the
 * first recording in the process saw it, so a family recording a `Math.random()`-derived param got
 * one value alone and a different one after any other family. Primed here, before the spy is
 * installed, so the draw is real and every recording starts at the same seeded value.
 */
let priming: Promise<void> | undefined
function primeReactActQueue(): Promise<void> {
  priming ??= (async () => {
    await act(async () => {})
  })()
  return priming
}

/** Whether this process has already paid React's one lazy draw; the scheduler test's oracle. */
export function reactActQueuePrimed(): boolean {
  return priming !== undefined
}

export function vitestRecordingScheduler(): RecordingScheduler {
  async function flush() {
    await act(async () => {
      // Drain promise continuations and due timers without advancing request deadlines.
      await vi.advanceTimersByTimeAsync(0)
    })
  }
  return {
    async start() {
      await primeReactActQueue()
      vi.useFakeTimers({
        toFake: [
          'Date',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'performance'
        ]
      })
      vi.setSystemTime(RECORDING_EPOCH)
      let seed = 1
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed / 4294967296
      }
      vi.spyOn(Math, 'random').mockImplementation(random)
      if (globalThis.crypto !== undefined) {
        let id = 0
        vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
          () => `00000000-0000-4000-8000-${(++id).toString(16).padStart(12, '0')}`
        )
      }
      if (globalThis.crypto !== undefined) {
        vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
          if (array) {
            const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
            for (let i = 0; i < bytes.length; i++) {
              bytes[i] = Math.floor(random() * 256)
            }
          }
          return array
        })
      }
    },
    flush,
    elapsed: () => Date.now() - RECORDING_EPOCH.getTime(),
    advance: async (ms) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    },
    stop() {
      vi.clearAllTimers()
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  }
}
