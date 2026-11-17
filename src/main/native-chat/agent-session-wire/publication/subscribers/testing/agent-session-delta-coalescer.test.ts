import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('agent-session delta coalescer', () => {
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

afterEach(() => vi.useRealTimers())

it('does not save unchanged text when a provider sends empty deltas', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const saved: string[] = []
  const coalescer = createAgentSessionDeltaCoalescer({ emit: (_key, text) => saved.push(text) })
  coalescer.append('reply', 'reply')
  vi.advanceTimersByTime(60)
  for (let i = 0; i < 10; i++) {
    coalescer.append('reply', '')
    vi.advanceTimersByTime(400)
  }
  expect(saved).toEqual(['reply'])
  coalescer.append('reply', ' tail')
  coalescer.flushAll()
  expect(saved).toEqual(['reply', 'reply tail'])
  coalescer.dispose()
})
