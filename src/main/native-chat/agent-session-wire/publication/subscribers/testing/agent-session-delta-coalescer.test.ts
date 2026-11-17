import { describe, expect, it } from 'vitest'
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

it('keeps old suffix snapshots exact while compacting tiny chunks and sizing escaped text', () => {
  const coalescer = createAgentSessionDeltaCoalescer({ schedule: () => () => {}, emit: () => {} })
  let text = ''
  let old: ReturnType<typeof coalescer.textSource>
  for (let index = 0; index < 10000; index++) {
    const delta = ['x', '\n', '"', '\\', '\ud800', '\udc00'][index % 6]!
    text += delta
    coalescer.append('a', delta)
    if (index === 100) {
      old = coalescer.textSource('a')
    }
    const source = coalescer.textSource('a')!
    expect(source.jsonBytes).toBe(Buffer.byteLength(JSON.stringify(text)) - 2)
    if (index % 31 === 0) {
      expect(coalescer.snapshot('a')?.text).toBe(text)
    }
  }
  expect(old!.suffix(20)).toBe(text.slice(20, old!.length))
  expect(coalescer.textSource('a')!.suffix(9900)).toBe(text.slice(9900))
  expect(coalescer.snapshot('a')?.text).toBe(text)
  coalescer.dispose()
})
