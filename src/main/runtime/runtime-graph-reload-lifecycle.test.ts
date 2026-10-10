import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RuntimeGraphReloadLifecycle,
  type RuntimeGraphReloadSettlement
} from './runtime-graph-reload-lifecycle'

describe('RuntimeGraphReloadLifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records success, failure, cancellation, and timeout as terminal outcomes', async () => {
    vi.useFakeTimers()
    const settlements: RuntimeGraphReloadSettlement[] = []
    const timeouts: number[] = []
    const lifecycle = new RuntimeGraphReloadLifecycle({
      timeoutMs: 100,
      onSettled: (settlement) => settlements.push(settlement),
      onTimeout: (revision) => timeouts.push(revision)
    })

    const success = lifecycle.begin(1)
    expect(lifecycle.settle(success, 'success')).toBe(true)
    const failure = lifecycle.begin(1)
    expect(lifecycle.settle(failure, 'failure')).toBe(true)
    const cancelled = lifecycle.begin(1)
    expect(lifecycle.settle(cancelled, 'cancelled')).toBe(true)
    const timeout = lifecycle.begin(1)
    await vi.advanceTimersByTimeAsync(100)

    expect(settlements.map(({ revision, outcome }) => ({ revision, outcome }))).toEqual([
      { revision: success, outcome: 'success' },
      { revision: failure, outcome: 'failure' },
      { revision: cancelled, outcome: 'cancelled' },
      { revision: timeout, outcome: 'timeout' }
    ])
    expect(timeouts).toEqual([timeout])
    expect(lifecycle.getActiveRevision()).toBeNull()
  })

  it('cancels a superseded generation and ignores its stale completion and timeout', async () => {
    vi.useFakeTimers()
    const settlements: RuntimeGraphReloadSettlement[] = []
    const timeouts: number[] = []
    const lifecycle = new RuntimeGraphReloadLifecycle({
      timeoutMs: 100,
      onSettled: (settlement) => settlements.push(settlement),
      onTimeout: (revision) => timeouts.push(revision)
    })

    const first = lifecycle.begin(1)
    await vi.advanceTimersByTimeAsync(60)
    const second = lifecycle.begin(1)

    expect(lifecycle.settle(first, 'success')).toBe(false)
    await vi.advanceTimersByTimeAsync(40)
    expect(timeouts).toEqual([])
    expect(lifecycle.getActiveRevision()).toBe(second)

    await vi.advanceTimersByTimeAsync(60)
    expect(timeouts).toEqual([second])
    expect(settlements.map(({ revision, outcome }) => ({ revision, outcome }))).toEqual([
      { revision: first, outcome: 'cancelled' },
      { revision: second, outcome: 'timeout' }
    ])
  })

  it('keeps a generation started by a cancellation observer active', async () => {
    vi.useFakeTimers()
    const settlements: RuntimeGraphReloadSettlement[] = []
    const timeouts: number[] = []
    let nestedRevision: number | null = null
    let didReenter = false
    let lifecycle!: RuntimeGraphReloadLifecycle
    lifecycle = new RuntimeGraphReloadLifecycle({
      timeoutMs: 100,
      onSettled: (settlement) => {
        settlements.push(settlement)
        if (settlement.outcome === 'cancelled' && !didReenter) {
          didReenter = true
          nestedRevision = lifecycle.begin(3)
        }
      },
      onTimeout: (revision) => timeouts.push(revision)
    })

    const first = lifecycle.begin(1)
    const replacement = lifecycle.begin(2)

    expect(replacement).toBe(2)
    expect(nestedRevision).toBe(3)
    expect(lifecycle.getActiveRevision()).toBe(nestedRevision)
    expect(lifecycle.settle(replacement, 'success')).toBe(false)

    await vi.advanceTimersByTimeAsync(100)

    expect(timeouts).toEqual([nestedRevision])
    expect(settlements.map(({ revision, outcome }) => ({ revision, outcome }))).toEqual([
      { revision: first, outcome: 'cancelled' },
      { revision: replacement, outcome: 'cancelled' },
      { revision: nestedRevision, outcome: 'timeout' }
    ])
  })
})
