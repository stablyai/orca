import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_DELTA_COALESCE_MS,
  createAgentSessionDeltaCoalescer
} from './agent-session-delta-coalescer'

/** Drives the window by hand so the test asserts scheduling, not wall time. */
function manualClock() {
  const pending: { run: () => void; ms: number }[] = []
  return {
    schedule: (run: () => void, ms: number) => {
      const entry = { run, ms }
      pending.push(entry)
      return () => {
        const index = pending.indexOf(entry)
        if (index !== -1) {
          pending.splice(index, 1)
        }
      }
    },
    fire: () => {
      const due = pending.splice(0)
      for (const entry of due) {
        entry.run()
      }
    },
    windows: () => pending.map((entry) => entry.ms),
    pendingCount: () => pending.length
  }
}

function coalescer(clock: ReturnType<typeof manualClock>, windowMs?: number) {
  const emitted: [string, string][] = []
  const instance = createAgentSessionDeltaCoalescer({
    emit: (key, text) => emitted.push([key, text]),
    schedule: clock.schedule,
    ...(windowMs === undefined ? {} : { windowMs })
  })
  return { instance, emitted }
}

describe('agent-session delta coalescer', () => {
  it('folds a burst into one emit carrying the full text, on one shared window', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'he')
    instance.append('item-1', 'llo')
    instance.append('item-2', 'world')

    expect(emitted).toEqual([])
    expect(clock.windows()).toEqual([AGENT_SESSION_DELTA_COALESCE_MS])

    clock.fire()
    expect(emitted).toEqual([
      ['item-1', 'hello'],
      ['item-2', 'world']
    ])
  })

  it('emits the accumulated snapshot again, not the increment, on the next window', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'he')
    clock.fire()
    instance.append('item-1', 'llo')
    clock.fire()

    expect(emitted).toEqual([
      ['item-1', 'he'],
      ['item-1', 'hello']
    ])
  })

  it('does not re-emit a stream with no new text', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'hi')
    clock.fire()
    instance.flushAll()

    expect(emitted).toEqual([['item-1', 'hi']])
  })

  it('flushes pending text ahead of a lifecycle event and cancels the window', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'partial')
    instance.flushAll()

    expect(emitted).toEqual([['item-1', 'partial']])
    expect(clock.pendingCount()).toBe(0)
  })

  it('drops a forgotten stream without emitting it, because its final body already landed', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'stale')
    instance.append('item-2', 'kept')
    instance.forget('item-1')
    clock.fire()

    expect(emitted).toEqual([['item-2', 'kept']])
  })

  it('emits nothing after dispose, and leaves no timer behind', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'gone')
    instance.dispose()
    clock.fire()

    expect(emitted).toEqual([])
    expect(clock.pendingCount()).toBe(0)
  })

  it('honours an overridden window', () => {
    const clock = manualClock()
    const { instance } = coalescer(clock, 5)

    instance.append('item-1', 'x')

    expect(clock.windows()).toEqual([5])
  })
})
