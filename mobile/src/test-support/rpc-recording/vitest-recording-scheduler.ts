import { act } from 'react-test-renderer'
import { vi } from 'vitest'
import type { RecordingScheduler } from './recording-scenario'

export function vitestRecordingScheduler(): RecordingScheduler {
  async function flush() {
    await act(async () => {
      // Drain promise continuations and due timers without advancing request deadlines.
      await vi.advanceTimersByTimeAsync(0)
    })
  }
  return {
    start() {
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
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
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
