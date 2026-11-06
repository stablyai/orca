import { describe, expect, it, vi } from 'vitest'
import { createAgentSessionDeltaCoalescer } from '../agent-session-delta-coalescer'

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
    emit: (key, { text }) => emitted.push([key, text]),
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
      emit: (_key, { text }) => {
        if (reject) {
          return false
        }
        emitted.push(text)
        return true
      }
    })

    instance.append('item-1', 'retry me')
    expect(instance.flush('item-1').accepted).toBe(false)
    expect(emitted).toEqual([])
    reject = false
    expect(instance.flush('item-1').accepted).toBe(true)
    expect(emitted).toEqual(['retry me'])
  })

  it('does not evict buffered output when flushing the oldest stream is backpressured', () => {
    const clock = manualClock()
    let reject = true
    const emitted: [string, string][] = []
    const instance = createAgentSessionDeltaCoalescer({
      maxStreams: 1,
      schedule: clock.schedule,
      emit: (key, { text }) => {
        if (reject) {
          return false
        }
        emitted.push([key, text])
        return true
      }
    })

    instance.append('first', 'preserve me')
    expect(instance.append('second', 'new stream').accepted).toBe(false)
    expect(instance.snapshot('first')?.text).toBe('preserve me')
    reject = false
    expect(instance.append('second', 'new stream').accepted).toBe(true)
    expect(emitted).toEqual([['first', 'preserve me']])
  })
})

it.each(['failed', 'closed'] as const)(
  'preserves checked %s admission and stops its scheduled retry while retaining full content',
  (reason) => {
    const clock = manualClock()
    const failure = { accepted: false, reason } as const
    const onScheduledFailure = vi.fn()
    const admitted = { accepted: true } as const
    let refuse = true
    const instance = createAgentSessionDeltaCoalescer({
      schedule: clock.schedule,
      emit: () => (refuse ? failure : admitted),
      onScheduledFailure
    })
    instance.append('plan', 'PT')
    expect(instance.flush('plan')).toBe(failure)
    clock.fire()
    expect(onScheduledFailure).toHaveBeenCalledExactlyOnceWith(failure)
    expect(clock.pendingCount()).toBe(0)
    expect(instance.snapshot('plan')?.text).toBe('PT')
    refuse = false
    expect(instance.flush('plan')).toBe(admitted)
    expect(instance.dirty()).toEqual([])
    instance.dispose()
  }
)

it('keeps other delivery opportunities after legacy backpressure and preserves the first terminal result', () => {
  const clock = manualClock()
  const failure = { accepted: false, reason: 'closed' } as const
  const emitted: string[] = []
  const instance = createAgentSessionDeltaCoalescer({
    schedule: clock.schedule,
    emit: (key) => {
      emitted.push(key)
      if (key === 'pressure') {
        return false
      }
      if (key === 'terminal') {
        return failure
      }
      return undefined
    }
  })
  for (const key of ['pressure', 'void', 'terminal', 'later']) {
    instance.append(key, key)
  }
  expect(instance.flushAll()).toBe(failure)
  expect(emitted).toEqual(['pressure', 'void', 'terminal'])
  expect(clock.pendingCount()).toBe(0)
  expect(instance.dirty().map((entry) => entry.key)).toEqual(['pressure', 'terminal', 'later'])
  instance.dispose()
})
