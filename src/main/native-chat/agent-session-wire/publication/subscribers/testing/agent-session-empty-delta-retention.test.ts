import { describe, expect, it, vi } from 'vitest'
import { createAgentSessionDeltaCoalescer } from '../agent-session-delta-coalescer'

describe('empty streamed deltas', () => {
  it('empty increments create no stream and do not dirty retained clean or dirty content', () => {
    const pending = new Set<() => void>()
    const emitted: { key: string; text: string }[] = []
    const instance = createAgentSessionDeltaCoalescer({
      schedule: (run) => {
        pending.add(run)
        return () => {
          pending.delete(run)
        }
      },
      emit: (key, { text }) => emitted.push({ key, text })
    })
    try {
      expect(instance.append('empty', '').accepted).toBe(true)
      expect(instance.snapshot('empty')).toBeNull()
      expect(pending.size).toBe(0)
      expect(instance.flushAll().accepted).toBe(true)
      expect(emitted).toEqual([])
      instance.append('live', 'visible')
      const before = instance.snapshot('live')
      instance.append('live', '')
      expect(instance.snapshot('live')).toEqual(before)
      expect(pending.size).toBe(1)
      expect(instance.flushAll().accepted).toBe(true)
      expect(emitted).toEqual([{ key: 'live', text: 'visible' }])
      instance.append('live', '')
      expect(instance.dirty()).toEqual([])
      expect(pending.size).toBe(0)
      expect(instance.flushAll().accepted).toBe(true)
      expect(emitted).toHaveLength(1)
    } finally {
      instance.dispose()
    }
    expect(pending.size).toBe(0)
  })

  it('empty input never evicts or refuses and preserves a genuine refused-tail wake', () => {
    vi.useFakeTimers()
    let accepting = false
    const emitted: [string, string][] = []
    const emit = vi.fn((key: string, { text }: { text: string }) => {
      if (!accepting) {
        return false
      }
      emitted.push([key, text])
      return true
    })
    const instance = createAgentSessionDeltaCoalescer({ maxStreams: 1, emit })
    try {
      instance.append('first', 'preserved')
      vi.advanceTimersByTime(60)
      expect(emit).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)
      const dirty = instance.dirty()
      expect(instance.append('second', '').accepted).toBe(true)
      expect(instance.append('first', '').accepted).toBe(true)
      expect(instance.snapshot('second')).toBeNull()
      expect(instance.dirty()).toEqual(dirty)
      expect(emit).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)
      accepting = true
      vi.advanceTimersByTime(60)
      expect(emitted).toEqual([['first', 'preserved']])
      expect(instance.snapshot('first')?.text).toBe('preserved')
      expect(instance.dirty()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      instance.dispose()
      vi.useRealTimers()
    }
  })
})
