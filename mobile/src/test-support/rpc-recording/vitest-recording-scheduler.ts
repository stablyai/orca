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

// Product timers main's scheduler silently cleared; they are inherited, not fixed, and still reported.
type KnownMainTimer = { delay: number; owner: readonly string[] }
const RECONNECT_WAIT = ['rpc-client-reconnect-wait', 'replay-on-ambiguous-delivery']
const KNOWN_MAIN_TIMERS: Readonly<Record<string, Readonly<Record<string, KnownMainTimer>>>> = {
  'matrix-session.tab-reveal-session.tabs.list-1': {
    'sc-reveal-first-poll.result-absent': {
      delay: 300,
      owner: ['reveal-mobile-source-control-session-diff', 'waitForDelay']
    }
  },
  'matrix-session.tab-reveal-session.tabs.activate-1': {
    'sc-reveal-first-poll.result-absent': {
      delay: 300,
      owner: ['reveal-mobile-source-control-session-diff', 'waitForDelay']
    }
  },
  'matrix-worktree.agent-launch-create-agent.launch-1': {
    'tw-create-retry-agent-launched.method-not-found': {
      delay: 20_000,
      owner: [...RECONNECT_WAIT, 'worktree-create-retry']
    }
  },
  'matrix-session.pr-triage-agent.launchreplay-1': {
    'pr-triage-launch.prelude': {
      delay: 20_000,
      owner: [...RECONNECT_WAIT, 'mobile-existing-agent-launch', 'pr-ai-triage-launch']
    }
  }
}

type TrackedTimer = {
  kind: 'timeout' | 'interval'
  delay: number
  stack: string
  release: () => void
}

// Track allocation and retirement only for a declared run, keeping the fake timer's own callback, arguments and handle.
function trackTimers(): Map<unknown, TrackedTimer> {
  const live = new Map<unknown, TrackedTimer>()
  const fakeSetTimeout = globalThis.setTimeout
  const fakeSetInterval = globalThis.setInterval
  const fakeClearTimeout = globalThis.clearTimeout
  const fakeClearInterval = globalThis.clearInterval
  const callable = (callback: unknown): ((...args: unknown[]) => unknown) => {
    if (typeof callback !== 'function') {
      throw new Error('A recorded timer needs a callback')
    }
    return function (this: unknown, ...args: unknown[]) {
      return Reflect.apply(callback, this, args)
    }
  }
  const allocation = (kind: TrackedTimer['kind'], delay: number | undefined) => ({
    kind,
    delay: delay ?? 0,
    stack: new Error('timer').stack ?? ''
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards the fake timer's exact arguments and returns its own handle.
  globalThis.setTimeout = ((callback: unknown, delay?: number, ...args: unknown[]) => {
    const original = callable(callback)
    const handle = fakeSetTimeout(
      function (this: unknown, ...fired: unknown[]) {
        live.delete(handle)
        return Reflect.apply(original, this, fired)
      },
      delay,
      ...args
    )
    live.set(handle, { ...allocation('timeout', delay), release: () => fakeClearTimeout(handle) })
    return handle
  }) as typeof setTimeout
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards the fake timer's exact arguments and returns its own handle.
  globalThis.setInterval = ((callback: unknown, delay?: number, ...args: unknown[]) => {
    const handle = fakeSetInterval(callable(callback), delay, ...args)
    live.set(handle, {
      ...allocation('interval', delay),
      release: () => fakeClearInterval(handle)
    })
    return handle
  }) as typeof setInterval
  globalThis.clearTimeout = (handle) => {
    live.delete(handle)
    fakeClearTimeout(handle)
  }
  globalThis.clearInterval = (handle) => {
    live.delete(handle)
    fakeClearInterval(handle)
  }
  return live
}

function knownMainTimerProblems(
  identity: string,
  declared: KnownMainTimer,
  live: ReadonlyMap<unknown, TrackedTimer>,
  count: number
): string[] {
  const survivors = [...live.values()]
  const problems: string[] = []
  if (count !== survivors.length) {
    problems.push(`${count} actual timers but ${survivors.length} tracked`)
  }
  if (survivors.length !== 1) {
    problems.push(`expected the one known main timer, found ${survivors.length}`)
  }
  for (const timer of survivors) {
    if (
      timer.kind !== 'timeout' ||
      timer.delay !== declared.delay ||
      !declared.owner.every((frame) => timer.stack.includes(frame))
    ) {
      problems.push(`unexpected ${timer.kind} of ${timer.delay} ms from\n${timer.stack}`)
    }
  }
  return problems.map((problem) => `${identity}: ${problem}`)
}

export function vitestRecordingScheduler(identity?: {
  producer: string
  scenario: string
}): RecordingScheduler {
  const known = identity && KNOWN_MAIN_TIMERS[identity.producer]?.[identity.scenario]
  let tracked: Map<unknown, TrackedTimer> | undefined
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
      tracked = known ? trackTimers() : undefined
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
        if (known && identity && tracked) {
          // Checked before restoration: the exact declared survivor, nothing else and no other owner.
          const problems = knownMainTimerProblems(
            `${identity.producer}/${identity.scenario}`,
            known,
            tracked,
            stopCount
          )
          if (problems.length) {
            errors.push(new Error(`Recording cleanup timers:\n${problems.join('\n')}`))
          } else {
            process.stdout.write(
              `known main timer retained: ${identity.producer}/${identity.scenario} ${known.delay} ms\n`
            )
            for (const timer of tracked.values()) {
              timer.release()
            }
          }
        } else if (stopCount !== 0) {
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
