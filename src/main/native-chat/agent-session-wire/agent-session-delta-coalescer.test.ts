import { describe, expect, it } from 'vitest'
import { createAgentSessionDeltaCoalescer } from './agent-session-delta-coalescer'

/** Drive scheduling without wall-clock timing. */
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

  it('retains dirty state and surfaces admission failure for retry', () => {
    const clock = manualClock()
    let reject = true
    const emitted: string[] = []
    const instance = createAgentSessionDeltaCoalescer({
      schedule: clock.schedule,
      emit: (_key, text) => {
        if (reject) {
          return false
        }
        emitted.push(text)
        return true
      }
    })

    instance.append('item-1', 'retry me')
    expect(instance.flush('item-1')).toBe(false)
    expect(emitted).toEqual([])
    reject = false
    expect(instance.flush('item-1')).toBe(true)
    expect(emitted).toEqual(['retry me'])
  })

  it('does not evict buffered output when flushing the oldest stream is backpressured', () => {
    const clock = manualClock()
    let reject = true
    const emitted: [string, string][] = []
    const instance = createAgentSessionDeltaCoalescer({
      maxStreams: 1,
      schedule: clock.schedule,
      emit: (key, text) => {
        if (reject) {
          return false
        }
        emitted.push([key, text])
        return true
      }
    })

    instance.append('first', 'preserve me')
    expect(instance.append('second', 'new stream')).toBe(false)
    expect(instance.snapshot('first')?.text).toBe('preserve me')
    reject = false
    expect(instance.append('second', 'new stream')).toBe(true)
    expect(emitted).toEqual([['first', 'preserve me']])
  })
})
