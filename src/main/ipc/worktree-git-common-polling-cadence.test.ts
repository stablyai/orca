import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorktreePollerWindowVisibility } from './worktree-base-directory-poller'
import { startAdaptiveGitCommonPoller } from './worktree-git-common-poll-cadence'

function createVisibilityHarness(): {
  source: WorktreePollerWindowVisibility
  hide: () => void
  show: () => void
} {
  let visible = true
  let listener: (() => void) | null = null
  return {
    source: {
      isWindowVisible: () => visible,
      onWindowBecameVisible: (nextListener) => {
        listener = nextListener
        return () => {
          if (listener === nextListener) {
            listener = null
          }
        }
      }
    },
    hide: () => {
      visible = false
    },
    show: () => {
      visible = true
      listener?.()
    }
  }
}

function controlledPromise<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('adaptive git-common poll cadence', () => {
  it('backs off after three unchanged polls and returns fast after a change', async () => {
    vi.useFakeTimers()
    const changes = [false, false, false, true, false]
    const poll = vi.fn(async () => ({ changed: changes.shift() ?? false }))
    const subscription = startAdaptiveGitCommonPoller({
      cadence: { activeIntervalMs: 100, idleIntervalMs: 500 },
      visibility: createVisibilityHarness().source,
      poll
    })

    await vi.advanceTimersByTimeAsync(300)
    expect(poll).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(499)
    expect(poll).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(99)
    expect(poll).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(5)

    await subscription.unsubscribe()
  })

  it('caps an idle delay at the monotonic index backstop deadline', async () => {
    vi.useFakeTimers()
    const forced: boolean[] = []
    const subscription = startAdaptiveGitCommonPoller({
      cadence: {
        activeIntervalMs: 100,
        idleIntervalMs: 500,
        indexBackstopIntervalMs: 700
      },
      visibility: createVisibilityHarness().source,
      poll: async (forceFullScan) => {
        forced.push(forceFullScan)
        return { changed: false }
      }
    })

    await vi.advanceTimersByTimeAsync(699)
    expect(forced).toEqual([false, false, false])
    await vi.advanceTimersByTimeAsync(1)
    expect(forced).toEqual([false, false, false, true])

    await subscription.unsubscribe()
  })

  it('retries a failed overdue scan at the nonzero active cadence', async () => {
    vi.useFakeTimers()
    const forced: boolean[] = []
    let failFirstForcedScan = true
    const subscription = startAdaptiveGitCommonPoller({
      cadence: {
        activeIntervalMs: 100,
        idleIntervalMs: 500,
        indexBackstopIntervalMs: 300
      },
      visibility: createVisibilityHarness().source,
      poll: async (forceFullScan) => {
        forced.push(forceFullScan)
        if (forceFullScan && failFirstForcedScan) {
          failFirstForcedScan = false
          throw new Error('transient stat failure')
        }
        return { changed: false }
      }
    })

    await vi.advanceTimersByTimeAsync(300)
    expect(forced).toEqual([false, false, true])
    await vi.advanceTimersByTimeAsync(99)
    expect(forced).toEqual([false, false, true])
    await vi.advanceTimersByTimeAsync(1)
    expect(forced).toEqual([false, false, true, true])

    await subscription.unsubscribe()
  })

  it('forces the retry after a failed regular poll', async () => {
    vi.useFakeTimers()
    const forced: boolean[] = []
    let failSecondPoll = true
    const subscription = startAdaptiveGitCommonPoller({
      cadence: {
        activeIntervalMs: 100,
        idleIntervalMs: 500,
        indexBackstopIntervalMs: 3000
      },
      visibility: createVisibilityHarness().source,
      poll: async (forceFullScan) => {
        forced.push(forceFullScan)
        if (forced.length === 2 && failSecondPoll) {
          failSecondPoll = false
          throw new Error('transient stat failure')
        }
        return { changed: false }
      }
    })

    await vi.advanceTimersByTimeAsync(300)
    // The retry runs forced so the dir-signature-gated `index` read cannot be skipped, then the
    // next tick drops back to a regular poll.
    expect(forced).toEqual([false, false, true])
    await vi.advanceTimersByTimeAsync(100)
    expect(forced).toEqual([false, false, true, false])

    await subscription.unsubscribe()
  })

  it('forces every visibility resume and coalesces one behind an in-flight poll', async () => {
    vi.useFakeTimers()
    const visibility = createVisibilityHarness()
    const first = controlledPromise<{ changed: boolean }>()
    const forced: boolean[] = []
    const poll = vi.fn((forceFullScan: boolean) => {
      forced.push(forceFullScan)
      return forced.length === 1 ? first.promise : Promise.resolve({ changed: false })
    })
    const subscription = startAdaptiveGitCommonPoller({
      cadence: { activeIntervalMs: 100, idleIntervalMs: 500 },
      visibility: visibility.source,
      poll
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(forced).toEqual([false])
    visibility.show()
    expect(forced).toEqual([false])

    first.resolve({ changed: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(forced).toEqual([false, true])

    await subscription.unsubscribe()
  })

  it('stops polling while the window is hidden and forces a scan on resume', async () => {
    vi.useFakeTimers()
    const visibility = createVisibilityHarness()
    const forced: boolean[] = []
    const subscription = startAdaptiveGitCommonPoller({
      cadence: { activeIntervalMs: 100, idleIntervalMs: 500 },
      visibility: visibility.source,
      poll: async (forceFullScan) => {
        forced.push(forceFullScan)
        return { changed: false }
      }
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(forced).toEqual([false])
    visibility.hide()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(forced).toEqual([false])

    visibility.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(forced).toEqual([false, true])
    // Resume restarts the active cadence rather than the idle one it parked on.
    await vi.advanceTimersByTimeAsync(100)
    expect(forced).toEqual([false, true, false])

    await subscription.unsubscribe()
  })

  it('replaces an outstanding idle timer when native activity resets cadence', async () => {
    vi.useFakeTimers()
    const poll = vi.fn(async () => ({ changed: false }))
    const subscription = startAdaptiveGitCommonPoller({
      cadence: { activeIntervalMs: 100, idleIntervalMs: 500 },
      visibility: createVisibilityHarness().source,
      poll
    })

    await vi.advanceTimersByTimeAsync(300)
    expect(poll).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(50)
    subscription.resetCadence()
    await vi.advanceTimersByTimeAsync(99)
    expect(poll).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(4)

    await subscription.unsubscribe()
  })

  it('neither pins the active cadence nor postpones the poll under an event storm', async () => {
    vi.useFakeTimers()
    const poll = vi.fn(async () => ({ changed: false }))
    const subscription = startAdaptiveGitCommonPoller({
      cadence: { activeIntervalMs: 100, idleIntervalMs: 500 },
      visibility: createVisibilityHarness().source,
      poll
    })

    // A chatty worktrees tree: an event every 50ms while nothing the poller reads ever moves.
    const storm = async (durationMs: number): Promise<void> => {
      for (let elapsed = 0; elapsed < durationMs; elapsed += 50) {
        await vi.advanceTimersByTimeAsync(50)
        subscription.resetCadence()
      }
    }

    // Resets land faster than the interval, yet the poll still runs on schedule.
    await storm(300)
    expect(poll).toHaveBeenCalledTimes(3)

    await storm(450)
    // Still idle-paced: the storm bought one accelerated wake, not a permanent 100ms cadence.
    expect(poll).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(50)
    expect(poll).toHaveBeenCalledTimes(4)

    await subscription.unsubscribe()
  })

  it('re-arms the activity accelerator once a poll confirms a real change', async () => {
    vi.useFakeTimers()
    const changes = [false, false, false, true]
    const poll = vi.fn(async () => ({ changed: changes.shift() ?? false }))
    const subscription = startAdaptiveGitCommonPoller({
      cadence: { activeIntervalMs: 100, idleIntervalMs: 500 },
      visibility: createVisibilityHarness().source,
      poll
    })

    await vi.advanceTimersByTimeAsync(300)
    expect(poll).toHaveBeenCalledTimes(3)
    subscription.resetCadence()
    await vi.advanceTimersByTimeAsync(100)
    expect(poll).toHaveBeenCalledTimes(4)

    // Back to idle after three more unchanged polls, with the accelerator restored by the change.
    await vi.advanceTimersByTimeAsync(300)
    expect(poll).toHaveBeenCalledTimes(7)
    subscription.resetCadence()
    await vi.advanceTimersByTimeAsync(99)
    expect(poll).toHaveBeenCalledTimes(7)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(8)

    await subscription.unsubscribe()
  })

  // Why: a degraded scan can never advance the backstop, so the forced retry re-latches forever.
  // Without a bound, a permanently unreadable tree (dead mount, root-owned dir, Windows ACL lock)
  // holds the 2s active cadence for the process lifetime.
  it('backs a chronically degraded forced scan off to the idle interval', async () => {
    vi.useFakeTimers()
    const forced: boolean[] = []
    const subscription = startAdaptiveGitCommonPoller({
      cadence: {
        activeIntervalMs: 100,
        idleIntervalMs: 500,
        indexBackstopIntervalMs: 300
      },
      visibility: createVisibilityHarness().source,
      poll: async (forceFullScan) => {
        forced.push(forceFullScan)
        return { changed: false, degraded: forceFullScan }
      }
    })

    await vi.advanceTimersByTimeAsync(300)
    expect(forced).toEqual([false, false, true])
    // Two more retries at the active interval before the bound trips.
    await vi.advanceTimersByTimeAsync(200)
    expect(forced).toEqual([false, false, true, true, true])
    // Still forced — the retry is what heals it — but no longer at the active cadence.
    await vi.advanceTimersByTimeAsync(499)
    expect(forced).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(1)
    expect(forced).toEqual([false, false, true, true, true, true])

    await subscription.unsubscribe()
  })

  it('keeps the active cadence while a degraded forced scan still reports changes', async () => {
    vi.useFakeTimers()
    const forced: boolean[] = []
    const subscription = startAdaptiveGitCommonPoller({
      cadence: {
        activeIntervalMs: 100,
        idleIntervalMs: 500,
        indexBackstopIntervalMs: 300
      },
      visibility: createVisibilityHarness().source,
      poll: async (forceFullScan) => {
        forced.push(forceFullScan)
        return { changed: forceFullScan, degraded: forceFullScan }
      }
    })

    await vi.advanceTimersByTimeAsync(300)
    expect(forced).toEqual([false, false, true])
    // One unreadable leaf must not slow a repo the user is visibly moving: the bound only counts
    // retries that resolved nothing.
    await vi.advanceTimersByTimeAsync(500)
    expect(forced).toHaveLength(8)

    await subscription.unsubscribe()
  })

  // Why: native activity landing mid-poll is the common case on a chatty tree — the poll that is
  // already running cannot have seen it, so the wake has to survive to the tail.
  it('coalesces native activity that lands while a poll is in flight', async () => {
    vi.useFakeTimers()
    const inFlight = controlledPromise<{ changed: boolean }>()
    const poll = vi.fn(
      (): Promise<{ changed: boolean }> =>
        poll.mock.calls.length === 4 ? inFlight.promise : Promise.resolve({ changed: false })
    )
    const subscription = startAdaptiveGitCommonPoller({
      cadence: { activeIntervalMs: 100, idleIntervalMs: 500 },
      visibility: createVisibilityHarness().source,
      poll
    })

    // Three unchanged polls settle the cadence into the 500ms idle interval.
    await vi.advanceTimersByTimeAsync(300)
    expect(poll).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(500)
    expect(poll).toHaveBeenCalledTimes(4)

    // Activity arrives 20ms into the fourth poll, which is therefore blind to it.
    await vi.advanceTimersByTimeAsync(20)
    subscription.resetCadence()
    inFlight.resolve({ changed: false })
    await vi.advanceTimersByTimeAsync(0)

    // The next poll is pulled in to activeIntervalMs after the activity, not a full idle interval
    // after the poll that missed it.
    await vi.advanceTimersByTimeAsync(99)
    expect(poll).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(5)

    await subscription.unsubscribe()
  })

  it('does not let a degraded forced scan satisfy the index backstop', async () => {
    vi.useFakeTimers()
    const forced: boolean[] = []
    let degradeFirstForcedScan = true
    const subscription = startAdaptiveGitCommonPoller({
      cadence: {
        activeIntervalMs: 100,
        idleIntervalMs: 500,
        indexBackstopIntervalMs: 300
      },
      visibility: createVisibilityHarness().source,
      poll: async (forceFullScan) => {
        forced.push(forceFullScan)
        if (forceFullScan && degradeFirstForcedScan) {
          degradeFirstForcedScan = false
          return { changed: false, degraded: true }
        }
        return { changed: false }
      }
    })

    await vi.advanceTimersByTimeAsync(300)
    expect(forced).toEqual([false, false, true])
    await vi.advanceTimersByTimeAsync(99)
    expect(forced).toHaveLength(3)
    // Retried like a thrown scan: a partial read never observed the gated index.
    await vi.advanceTimersByTimeAsync(1)
    expect(forced).toEqual([false, false, true, true])

    await vi.advanceTimersByTimeAsync(299)
    expect(forced).toHaveLength(4)
    // The backstop clock restarted at the complete scan, not at the degraded one.
    await vi.advanceTimersByTimeAsync(1)
    expect(forced).toEqual([false, false, true, true, true])

    await subscription.unsubscribe()
  })
})
