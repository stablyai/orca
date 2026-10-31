import { act } from 'react-test-renderer'
import { vi } from 'vitest'
import type { RecordingScheduler } from './recording-scenario'

const RECORDING_EPOCH = new Date('2026-01-01T00:00:00Z')

// Prime act before seeding: React lazily draws Math.random once per process, which would shift only the first recording’s ids.
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
  let baseline: number | undefined
  let stopCount: number | undefined
  let started = false
  let stopAttempted = false
  let clockRestored = false
  let spiesRestored = false
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
      started = true
      baseline = vi.getTimerCount()
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
    timerEvidence() {
      if (!started || baseline === undefined) {
        throw new Error('Recording clock never started')
      }
      if (stopAttempted && stopCount === undefined) {
        throw new Error('Pre-restore timer residual unavailable')
      }
      return {
        baseline,
        residual: stopCount ?? vi.getTimerCount(),
        stopped: stopAttempted && clockRestored && spiesRestored,
        stopAttempted,
        clockRestored,
        spiesRestored
      }
    },
    stop() {
      if (stopAttempted) {
        throw new Error('Recording scheduler stop already attempted')
      }
      stopAttempted = true
      const errors: unknown[] = []
      try {
        stopCount = vi.getTimerCount()
        if (stopCount !== 0) {
          errors.push(new Error(`Recording cleanup retained ${stopCount} actual timers`))
        }
      } catch (error) {
        errors.push(error)
      }
      try {
        vi.useRealTimers()
        clockRestored = true
      } catch (error) {
        errors.push(error)
      }
      try {
        vi.restoreAllMocks()
        spiesRestored = true
      } catch (error) {
        errors.push(error)
      }
      if (errors.length === 1) {
        throw errors[0]
      }
      if (errors.length) {
        throw new AggregateError(errors, 'Recording scheduler stop failed')
      }
    }
  }
}
